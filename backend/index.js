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
      visible_publico INTEGER DEFAULT 1, etiquetas_extra TEXT, barrio TEXT, barrio_manual INTEGER DEFAULT 0
    )
  `);
  try { await db.execute(`ALTER TABLE restaurantes ADD COLUMN barrio TEXT`); } catch (e) {}
  try { await db.execute(`ALTER TABLE restaurantes ADD COLUMN barrio_manual INTEGER DEFAULT 0`); } catch (e) {}
  await db.execute(`
    CREATE TABLE IF NOT EXISTS categorias (
      id TEXT PRIMARY KEY, restaurante_id TEXT NOT NULL, nombre TEXT, precio TEXT,
      valoracion INTEGER, resena TEXT, instagram_url TEXT, subcategoria TEXT, tiktok_url TEXT
    )
  `);
  try { await db.execute(`ALTER TABLE categorias ADD COLUMN instagram_url TEXT`); } catch (e) {}
  try { await db.execute(`ALTER TABLE categorias ADD COLUMN subcategoria TEXT`); } catch (e) {}
  try { await db.execute(`ALTER TABLE categorias ADD COLUMN tiktok_url TEXT`); } catch (e) {}

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
        sql: `INSERT INTO categorias (id, restaurante_id, nombre, precio, valoracion, resena, instagram_url, tiktok_url)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [c.id, r.id, c.nombre, c.precio, c.valoracion, c.resena, c.instagram_url || null, c.tiktok_url || null]
      });
    }
  }
  console.log(`Cargados ${restaurantes.length} restaurantes iniciales.`);
}

function extraerBarrio(direccion) {
  if (!direccion) return null;
  const partes = direccion.split(',').map(p => p.trim()).filter(Boolean);
  const idxPostal = partes.findIndex(p => /^\d{4,5}\b/.test(p));
  if (idxPostal > 1) {
    const candidato = partes[idxPostal - 1];
    if (candidato && !/^\d+$/.test(candidato)) return candidato;
  }
  const posible = partes.find((p, i) => i > 0 && !/\d/.test(p) && !/valencia|españa|valència/i.test(p));
  return posible || null;
}

async function migrarBarrios() {
  const { rows } = await db.execute(`SELECT id, direccion, barrio, barrio_manual FROM restaurantes`);
  console.log(`Revisando barrios: ${rows.length} restaurantes en total.`);
  const candidatos = rows.filter(f => f.direccion && !f.barrio_manual);
  let actualizados = 0;
  for (const fila of candidatos) {
    const barrio = extraerBarrio(fila.direccion);
    if (barrio && barrio !== fila.barrio) {
      await db.execute({ sql: 'UPDATE restaurantes SET barrio = ? WHERE id = ?', args: [barrio, fila.id] });
      actualizados++;
    }
  }
  console.log(`Barrio recalculado y guardado para ${actualizados} restaurantes.`);
}

const ARBOL_CATEGORIAS_INICIAL = [
  { nombre: 'Esmorzar', padre: null },
  { nombre: 'Premium', padre: 'Esmorzar' },
  { nombre: 'Tradicional', padre: 'Esmorzar' },
  { nombre: 'Brunch', padre: null },
  { nombre: 'Fusion', padre: null },
  { nombre: 'Nikkei', padre: 'Fusion' },
  { nombre: 'Asiatico mediterraneo', padre: 'Fusion' },
  { nombre: 'Otros', padre: 'Fusion' },
  { nombre: 'Tapas', padre: null },
  { nombre: 'Paella/arroces', padre: null },
  { nombre: 'Tortilla de patatas', padre: null },
  { nombre: 'Italiano', padre: null },
  { nombre: 'Pasta', padre: 'Italiano' },
  { nombre: 'Pizza', padre: 'Italiano' },
  { nombre: 'Focaccia', padre: 'Italiano' },
  { nombre: 'Pizza romana y otros tipos', padre: 'Focaccia' },
  { nombre: 'Pizza napolitana', padre: 'Focaccia' },
  { nombre: 'Asiatico', padre: null },
  { nombre: 'Japones', padre: 'Asiatico' },
  { nombre: 'Ramen Japones', padre: 'Japones' },
  { nombre: 'Sushi', padre: 'Japones' },
  { nombre: 'Sushi Buffet', padre: 'Sushi' },
  { nombre: 'Chino', padre: 'Asiatico' },
  { nombre: 'Ramen Chino', padre: 'Chino' },
  { nombre: 'Tailandes', padre: 'Asiatico' },
  { nombre: 'Coreano', padre: 'Asiatico' },
  { nombre: 'Latino', padre: null },
  { nombre: 'Mexicano', padre: 'Latino' },
  { nombre: 'Peruano', padre: 'Latino' },
  { nombre: 'Saludables', padre: null },
  { nombre: 'Vegetariano', padre: null },
  { nombre: 'Vegano', padre: 'Vegetariano' },
  { nombre: 'Desayuno', padre: null },
  { nombre: 'Café', padre: 'Desayuno' },
  { nombre: 'Matcha', padre: 'Desayuno' },
  { nombre: 'Dulces', padre: null },
  { nombre: 'Tarta de queso', padre: 'Dulces' },
  { nombre: 'Horchata', padre: 'Dulces' },
  { nombre: 'Buñuelos', padre: 'Dulces' },
  { nombre: 'Helados', padre: 'Dulces' },
  { nombre: 'Hornos', padre: 'Dulces' },
  { nombre: 'Hamburguesa', padre: null },
  { nombre: 'Smash', padre: 'Hamburguesa' },
  { nombre: 'Normal', padre: 'Hamburguesa' },
  { nombre: 'Pollo', padre: 'Hamburguesa' },
  { nombre: 'Kebab y Shawarmas', padre: null },
  { nombre: 'Kebab', padre: 'Kebab y Shawarmas' },
  { nombre: 'Kebab premium', padre: 'Kebab' },
  { nombre: 'Kebab tradicional', padre: 'Kebab' },
  { nombre: 'Shawarma', padre: 'Kebab y Shawarmas' },
];

async function migrarCategoriasMaestro() {
  await db.execute(`CREATE TABLE IF NOT EXISTS categorias_maestro (nombre TEXT PRIMARY KEY, padre TEXT, orden INTEGER)`);
  try { await db.execute(`ALTER TABLE categorias_maestro ADD COLUMN orden INTEGER`); } catch (e) {}
  const { rows } = await db.execute('SELECT COUNT(*) as total FROM categorias_maestro');
  const { rows: yaAplicado } = await db.execute(`SELECT 1 FROM categorias_maestro WHERE nombre = 'Kebab y Shawarmas'`);
  if (rows[0].total > 0 && yaAplicado.length > 0) {
    console.log(`Categorías maestro: ya hay ${rows[0].total} y el árbol nuevo ya está aplicado.`);
    return;
  }
  await db.execute('DELETE FROM categorias_maestro');
  for (let i = 0; i < ARBOL_CATEGORIAS_INICIAL.length; i++) {
    const n = ARBOL_CATEGORIAS_INICIAL[i];
    await db.execute({ sql: 'INSERT OR IGNORE INTO categorias_maestro (nombre, padre, orden) VALUES (?, ?, ?)', args: [n.nombre, n.padre, i] });
  }
  console.log(`Árbol de categorías sustituido por el nuevo: ${ARBOL_CATEGORIAS_INICIAL.length} categorías.`);
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
      resena: c.resena, instagram_url: c.instagram_url, subcategoria: c.subcategoria, tiktok_url: c.tiktok_url
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
  const campos = ['nombre', 'lat', 'lng', 'direccion', 'google_maps_url', 'barrio', 'barrio_manual',
    'notas_generales', 'probado', 'pendiente_revisar', 'visible_publico'];
  const { rows } = await db.execute({ sql: 'SELECT * FROM restaurantes WHERE id = ?', args: [req.params.id] });
  if (!rows[0]) return res.status(404).json({ error: 'No encontrado' });

  const actualizados = { ...rows[0] };
  for (const campo of campos) if (req.body[campo] !== undefined) actualizados[campo] = req.body[campo];
  if (req.body.etiquetas_extra !== undefined) actualizados.etiquetas_extra = JSON.stringify(req.body.etiquetas_extra);

  await db.execute({
    sql: `UPDATE restaurantes SET nombre=?, lat=?, lng=?, direccion=?, google_maps_url=?,
            notas_generales=?, probado=?, pendiente_revisar=?, visible_publico=?, etiquetas_extra=?, barrio=?, barrio_manual=?
          WHERE id=?`,
    args: [actualizados.nombre, actualizados.lat, actualizados.lng, actualizados.direccion,
      actualizados.google_maps_url, actualizados.notas_generales,
      actualizados.probado ? 1 : 0, actualizados.pendiente_revisar ? 1 : 0,
      actualizados.visible_publico ? 1 : 0, actualizados.etiquetas_extra, actualizados.barrio,
      actualizados.barrio_manual ? 1 : 0, req.params.id]
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
  const { nombre, precio, valoracion, resena, instagram_url, subcategoria, tiktok_url } = req.body;
  await db.execute({
    sql: `INSERT INTO categorias (id, restaurante_id, nombre, precio, valoracion, resena, instagram_url, subcategoria, tiktok_url)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, req.params.id, nombre, precio, valoracion, resena, instagram_url || null, subcategoria || null, tiktok_url || null]
  });
  res.status(201).json({ id, nombre, precio, valoracion, resena, instagram_url, subcategoria, tiktok_url });
});

app.put('/api/categorias/:catId', requiereAuth, async (req, res) => {
  const { nombre, precio, valoracion, resena, instagram_url, subcategoria, tiktok_url } = req.body;
  await db.execute({
    sql: `UPDATE categorias SET nombre=?, precio=?, valoracion=?, resena=?, instagram_url=?, subcategoria=?, tiktok_url=? WHERE id=?`,
    args: [nombre, precio, valoracion, resena, instagram_url || null, subcategoria || null, tiktok_url || null, req.params.catId]
  });
  res.json({ id: req.params.catId, nombre, precio, valoracion, resena, instagram_url, subcategoria, tiktok_url });
});

app.delete('/api/categorias/:catId', requiereAuth, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM categorias WHERE id = ?', args: [req.params.catId] });
  res.status(204).end();
});

app.get('/api/categorias-maestro', async (req, res) => {
  const { rows } = await db.execute('SELECT nombre, padre, orden FROM categorias_maestro ORDER BY orden ASC, nombre ASC');
  res.json(rows);
});

// Crea o actualiza UNA sola categoría (no toca las demás, evita que los guardados se pisen entre sí).
// Si ya existe, mantiene su orden actual; si es nueva, la coloca al final.
app.post('/api/categorias-maestro', requiereAuth, async (req, res) => {
  const { nombre, padre } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre' });
  const { rows: existente } = await db.execute({ sql: 'SELECT orden FROM categorias_maestro WHERE nombre = ?', args: [nombre] });
  if (existente.length) {
    await db.execute({ sql: 'UPDATE categorias_maestro SET padre = ? WHERE nombre = ?', args: [padre || null, nombre] });
  } else {
    const { rows: maxRow } = await db.execute('SELECT MAX(orden) as maximo FROM categorias_maestro');
    const nuevoOrden = (maxRow[0].maximo === null ? -1 : maxRow[0].maximo) + 1;
    await db.execute({ sql: 'INSERT INTO categorias_maestro (nombre, padre, orden) VALUES (?, ?, ?)', args: [nombre, padre || null, nuevoOrden] });
  }
  res.json({ ok: true });
});

// Mueve una categoría un puesto arriba o abajo entre sus hermanas (mismo padre)
app.put('/api/categorias-maestro/:nombre/orden', requiereAuth, async (req, res) => {
  const { direccion } = req.body; // 'arriba' o 'abajo'
  const { rows: actual } = await db.execute({ sql: 'SELECT padre FROM categorias_maestro WHERE nombre = ?', args: [req.params.nombre] });
  if (!actual.length) return res.status(404).json({ error: 'No encontrada' });
  const padre = actual[0].padre;
  const { rows: hermanas } = padre === null
    ? await db.execute('SELECT nombre, orden FROM categorias_maestro WHERE padre IS NULL ORDER BY orden ASC, nombre ASC')
    : await db.execute({ sql: 'SELECT nombre, orden FROM categorias_maestro WHERE padre = ? ORDER BY orden ASC, nombre ASC', args: [padre] });
  const idx = hermanas.findIndex(h => h.nombre === req.params.nombre);
  const destino = direccion === 'arriba' ? idx - 1 : idx + 1;
  if (idx === -1 || destino < 0 || destino >= hermanas.length) return res.json({ ok: true });
  const a = hermanas[idx], b = hermanas[destino];
  await db.execute({ sql: 'UPDATE categorias_maestro SET orden = ? WHERE nombre = ?', args: [b.orden, a.nombre] });
  await db.execute({ sql: 'UPDATE categorias_maestro SET orden = ? WHERE nombre = ?', args: [a.orden, b.nombre] });
  res.json({ ok: true });
});

// Renombra una categoría: actualiza sus hijas (que la tenían como padre)
// y todos los restaurantes que ya la tenían asignada, para que no se pierda el vínculo.
app.put('/api/categorias-maestro/:nombre/renombrar', requiereAuth, async (req, res) => {
  const nombreActual = req.params.nombre;
  const nuevoNombre = (req.body.nuevoNombre || '').trim();
  if (!nuevoNombre) return res.status(400).json({ error: 'Falta el nuevo nombre' });
  if (nuevoNombre === nombreActual) return res.json({ ok: true });
  const { rows: existe } = await db.execute({ sql: 'SELECT 1 FROM categorias_maestro WHERE nombre = ?', args: [nuevoNombre] });
  if (existe.length) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
  const { rows: actual } = await db.execute({ sql: 'SELECT padre, orden FROM categorias_maestro WHERE nombre = ?', args: [nombreActual] });
  if (!actual.length) return res.status(404).json({ error: 'No encontrada' });
  await db.execute({ sql: 'INSERT INTO categorias_maestro (nombre, padre, orden) VALUES (?, ?, ?)', args: [nuevoNombre, actual[0].padre, actual[0].orden] });
  await db.execute({ sql: 'DELETE FROM categorias_maestro WHERE nombre = ?', args: [nombreActual] });
  await db.execute({ sql: 'UPDATE categorias_maestro SET padre = ? WHERE padre = ?', args: [nuevoNombre, nombreActual] });
  await db.execute({ sql: 'UPDATE categorias SET nombre = ? WHERE nombre = ?', args: [nuevoNombre, nombreActual] });
  res.json({ ok: true });
});

app.delete('/api/categorias-maestro/:nombre', requiereAuth, async (req, res) => {
  await db.execute({ sql: 'DELETE FROM categorias_maestro WHERE nombre = ?', args: [req.params.nombre] });
  res.json({ ok: true });
});

// Red de seguridad: si algo falla de forma inesperada en una petición,
// que se registre el error, pero que el servidor no se caiga entero.
process.on('unhandledRejection', (err) => {
  console.error('Error no controlado (el servidor sigue funcionando):', err);
});

const PORT = process.env.PORT || 3001;
prepararBaseDeDatos()
  .then(() => migrarBarrios())
  .then(() => migrarCategoriasMaestro())
  .then(() => app.listen(PORT, () => console.log(`Backend escuchando en el puerto ${PORT}`)))
  .catch(err => { console.error('Error preparando la base de datos:', err); process.exit(1); });
