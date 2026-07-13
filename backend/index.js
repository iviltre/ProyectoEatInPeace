require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const fs = require('fs');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function prepararBaseDeDatos() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS restaurantes (
      id TEXT PRIMARY KEY, nombre TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL,
      direccion TEXT, google_maps_url TEXT, notas_generales TEXT, grupo_id TEXT,
      probado INTEGER DEFAULT 0, pendiente_revisar INTEGER DEFAULT 0,
      visible_publico INTEGER DEFAULT 1, etiquetas_extra TEXT, barrio TEXT
    )
  `);
  try { await db.execute(`ALTER TABLE restaurantes ADD COLUMN barrio TEXT`); } catch (e) {}
  await db.execute(`
    CREATE TABLE IF NOT EXISTS categorias (
      id TEXT PRIMARY KEY, restaurante_id TEXT NOT NULL, nombre TEXT, precio TEXT,
      valoracion INTEGER, resena TEXT, instagram_url TEXT, subcategoria TEXT
    )
  `);
  try { await db.execute(`ALTER TABLE categorias ADD COLUMN instagram_url TEXT`); } catch (e) {}
  try { await db.execute(`ALTER TABLE categorias ADD COLUMN subcategoria TEXT`); } catch (e) {}

  const { rows } = await db.execute('SELECT COUNT(*) as total FROM restaurantes');
  if (rows[0].total > 0) {
    console.log(`Base de datos ya tiene ${rows[0].total} restaurantes, no se rellena de nuevo.`);
    return;
  }

  if (!fs.existsSync('./seed-data.json')) {
    console.log('No hay seed-data.json, arrancando con base de datos vacía.');
    return;
  }

  console.log('Base de datos vacía, cargando datos iniciales...');
  const restaurantes = JSON.parse(fs.readFileSync('./seed-data.json', 'utf-8'));
  for (const r of restaurantes) {
    await db.execute({
      sql: `INSERT INTO restaurantes (id, nombre, lat, lng, direccion, google_maps_url, notas_generales,
              grupo_id, probado, pendiente_revisar, visible_publico, etiquetas_extra)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [r.id, r.nombre, r.lat, r.lng, r.direccion, r.google_maps_url, r.notas_generales,
        r.grupo_id, r.probado ? 1 : 0, r.pendiente_revisar ? 1 : 0, r.visible_publico ? 1 : 0,
        JSON.stringify(r.etiquetas_extra || [])]
    });
    for (const c of r.categorias) {
      await db.execute({
        sql: `INSERT INTO categorias (id, restaurante_id, nombre, precio, valoracion, resena, instagram_url)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [c.id, r.id, c.nombre, c.precio, c.valoracion, c.resena, c.instagram_url || null]
      });
    }
  }
  console.log(`Cargados ${restaurantes.length} restaurantes iniciales.`);
}

function extraerBarrio(direccion) {
  if (!direccion) return null;
  const partes = direccion.split(',').map(p => p.trim()).filter(Boolean);
  const posible = partes.find((p, i) => i > 0 && !/\d/.test(p) && !/valencia|españa|valència/i.test(p));
  return posible || null;
}

async function migrarBarrios() {
  const { rows } = await db.execute(`SELECT id, direccion, barrio FROM restaurantes`);
  console.log(`Revisando barrios: ${rows.length} restaurantes en total.`);
  const candidatos = rows.filter(f => (!f.barrio || f.barrio === '') && f.direccion);
  console.log(`Candidatos sin barrio con dirección: ${candidatos.length}.`);
  if (candidatos.length) {
    console.log('Ejemplo de dirección a procesar:', JSON.stringify(candidatos[0].direccion));
    console.log('Barrio que se extraería de ese ejemplo:', extraerBarrio(candidatos[0].direccion));
  }
  let actualizados = 0;
  for (const fila of candidatos) {
    const barrio = extraerBarrio(fila.direccion);
    if (barrio) {
      await db.execute({ sql: 'UPDATE restaurantes SET barrio = ? WHERE id = ?', args: [barrio, fila.id] });
      actualizados++;
    }
  }
  console.log(`Barrio extraído y guardado para ${actualizados} restaurantes.`);
}

async function construirRestaurante(fila, soloPublico) {
  const { rows: categorias } = await db.execute({
    sql: 'SELECT * FROM categorias WHERE restaurante_id = ?', args: [fila.id]
  });
  const obj = {
    id: fila.id, nombre: fila.nombre, lat: fila.lat, lng: fila.lng,
    direccion: fila.direccion, google_maps_url: fila.google_maps_url, grupo_id: fila.grupo_id,
    barrio: fila.barrio,
    probado: !!fila.probado, etiquetas_extra: JSON.parse(fila.etiquetas_extra || '[]'),
    categorias: categorias.map(c => ({
      id: c.id, nombre: c.nombre, precio: c.precio, valoracion: c.valoracion,
      resena: c.resena, instagram_url: c.instagram_url, subcategoria: c.subcategoria
    })),
  };
  if (!soloPublico) {
    obj.notas_generales = fila.notas_generales;
    obj.pendiente_revisar = !!fila.pendiente_revisar;
    obj.visible_publico = !!fila.visible_publico;
  }
  return obj;
}

function requiereAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Falta iniciar sesión' });
  try {
    jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión no válida, vuelve a iniciar sesión' });
  }
}

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

app.get('/api/restaurantes', async (req, res) => {
  const esAdmin = (() => {
    try { jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET); return true; }
    catch { return false; }
  })();

  const { rows } = esAdmin
    ? await db.execute('SELECT * FROM restaurantes')
    : await db.execute('SELECT * FROM restaurantes WHERE visible_publico = 1');

  const resultado = await Promise.all(rows.map(f => construirRestaurante(f, !esAdmin)));
  res.json(resultado);
});

app.post('/api/restaurantes', requiereAuth, async (req, res) => {
  const { nombre, lat, lng, direccion, google_maps_url, barrio } = req.body;
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO restaurantes (id, nombre, lat, lng, direccion, google_maps_url,
            notas_generales, grupo_id, probado, pendiente_revisar, visible_publico, etiquetas_extra, barrio)
          VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 1, '[]', ?)`,
    args: [id, nombre || 'Nuevo restaurante', lat, lng, direccion || null, google_maps_url || null, barrio || null]
  });
  const { rows } = await db.execute({ sql: 'SELECT * FROM restaurantes WHERE id = ?', args: [id] });
  res.status(201).json(await construirRestaurante(rows[0], false));
});

app.put('/api/restaurantes/:id', requiereAuth, async (req, res) => {
  const campos = ['nombre', 'lat', 'lng', 'direccion', 'google_maps_url', 'barrio',
    'notas_generales', 'probado', 'pendiente_revisar', 'visible_publico'];
  const { rows } = await db.execute({ sql: 'SELECT * FROM restaurantes WHERE id = ?', args: [req.params.id] });
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });

  const actualizados = { ...rows[0] };
  for (const campo of campos) if (req.body[campo] !== undefined) actualizados[campo] = req.body[campo];
  if (req.body.etiquetas_extra !== undefined) actualizados.etiquetas_extra = JSON.stringify(req.body.etiquetas_extra);

  await db.execute({
    sql: `UPDATE restaurantes SET nombre=?, lat=?, lng=?, direccion=?, google_maps_url=?,
            notas_generales=?, probado=?, pendiente_revisar=?, visible_publico=?, etiquetas_extra=?, barrio=?
          WHERE id=?`,
    args: [actualizados.nombre, actualizados.lat, actualizados.lng, actualizados.direccion,
      actualizados.google_maps_url, actualizados.notas_generales,
      actualizados.probado ? 1 : 0, actualizados.pendiente_revisar ? 1 : 0,
      actualizados.visible_publico ? 1 : 0, actualizados.etiquetas_extra, actualizados.barrio, req.params.id]
  });
  const { rows: nuevaFila } = await db.execute({ sql: 'SELECT * FROM restaurantes WHERE id = ?', args: [req.params.id] });
  res.json(await construirRestaurante(nuevaFila[0], false));
});

app.delete('/api/restaurantes/:id', requiereAuth, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM categorias WHERE restaurante_id = ?', args: [req.params.id] });
  await db.execute({ sql: 'DELETE FROM restaurantes WHERE id = ?', args: [req.params.id] });
  res.status(204).end();
});

app.post('/api/restaurantes/:id/categorias', requiereAuth, async (req, res) => {
  const id = randomUUID();
  const { nombre, precio, valoracion, resena, instagram_url, subcategoria } = req.body;
  await db.execute({
    sql: `INSERT INTO categorias (id, restaurante_id, nombre, precio, valoracion, resena, instagram_url, subcategoria)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, req.params.id, nombre, precio, valoracion, resena, instagram_url || null, subcategoria || null]
  });
  res.status(201).json({ id, nombre, precio, valoracion, resena, instagram_url, subcategoria });
});

app.put('/api/categorias/:catId', requiereAuth, async (req, res) => {
  const { nombre, precio, valoracion, resena, instagram_url, subcategoria } = req.body;
  await db.execute({
    sql: `UPDATE categorias SET nombre=?, precio=?, valoracion=?, resena=?, instagram_url=?, subcategoria=? WHERE id=?`,
    args: [nombre, precio, valoracion, resena, instagram_url || null, subcategoria || null, req.params.catId]
  });
  res.json({ id: req.params.catId, nombre, precio, valoracion, resena, instagram_url, subcategoria });
});

app.delete('/api/categorias/:catId', requiereAuth, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM categorias WHERE id = ?', args: [req.params.catId] });
  res.status(204).end();
});

const PORT = process.env.PORT || 3001;
prepararBaseDeDatos()
  .then(() => migrarBarrios())
  .then(() => app.listen(PORT, () => console.log(`Backend escuchando en el puerto ${PORT}`)))
  .catch(err => { console.error('Error preparando la base de datos:', err); process.exit(1); });
