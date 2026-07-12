require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');

const db = new Database('restaurantes.db');
const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// --- Ayuda: convierte una fila de restaurante + sus categorias en un objeto limpio ---
function construirRestaurante(fila, soloPublico) {
  const categorias = db.prepare('SELECT * FROM categorias WHERE restaurante_id = ?').all(fila.id);
  const obj = {
    id: fila.id,
    nombre: fila.nombre,
    lat: fila.lat,
    lng: fila.lng,
    direccion: fila.direccion,
    google_maps_url: fila.google_maps_url,
    grupo_id: fila.grupo_id,
    probado: !!fila.probado,
    etiquetas_extra: JSON.parse(fila.etiquetas_extra || '[]'),
    categorias: categorias.map(c => ({
      id: c.id, nombre: c.nombre, precio: c.precio, valoracion: c.valoracion, resena: c.resena
    })),
  };
  if (!soloPublico) {
    obj.notas_generales = fila.notas_generales;
    obj.pendiente_revisar = !!fila.pendiente_revisar;
    obj.visible_publico = !!fila.visible_publico;
  }
  return obj;
}

// --- Middleware: comprueba que quien edita tiene la contraseña correcta ---
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

// --- LOGIN: la app privada manda la contraseña una vez y recibe un pase (token) ---
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token });
});

// --- LISTAR: pública solo ve sitios marcados como visibles; el admin los ve todos ---
app.get('/api/restaurantes', (req, res) => {
  const esAdmin = (() => {
    try {
      jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
      return true;
    } catch { return false; }
  })();

  const filas = esAdmin
    ? db.prepare('SELECT * FROM restaurantes').all()
    : db.prepare('SELECT * FROM restaurantes WHERE visible_publico = 1').all();

  res.json(filas.map(f => construirRestaurante(f, !esAdmin)));
});

// --- CREAR restaurante nuevo (clic en el mapa) ---
app.post('/api/restaurantes', requiereAuth, (req, res) => {
  const { nombre, lat, lng, direccion, google_maps_url } = req.body;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO restaurantes (id, nombre, lat, lng, direccion, google_maps_url,
      notas_generales, grupo_id, probado, pendiente_revisar, visible_publico, etiquetas_extra)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 1, '[]')
  `).run(id, nombre || 'Nuevo restaurante', lat, lng, direccion || null, google_maps_url || null);
  const fila = db.prepare('SELECT * FROM restaurantes WHERE id = ?').get(id);
  res.status(201).json(construirRestaurante(fila, false));
});

// --- EDITAR restaurante (cualquier campo, incluida la posición del marcador) ---
app.put('/api/restaurantes/:id', requiereAuth, (req, res) => {
  const campos = ['nombre', 'lat', 'lng', 'direccion', 'google_maps_url',
    'notas_generales', 'probado', 'pendiente_revisar', 'visible_publico'];
  const existentes = db.prepare('SELECT * FROM restaurantes WHERE id = ?').get(req.params.id);
  if (!existentes) return res.status(404).json({ error: 'No encontrado' });

  const actualizados = { ...existentes };
  for (const campo of campos) {
    if (req.body[campo] !== undefined) actualizados[campo] = req.body[campo];
  }
  if (req.body.etiquetas_extra !== undefined) {
    actualizados.etiquetas_extra = JSON.stringify(req.body.etiquetas_extra);
  }

  db.prepare(`
    UPDATE restaurantes SET nombre=?, lat=?, lng=?, direccion=?, google_maps_url=?,
      notas_generales=?, probado=?, pendiente_revisar=?, visible_publico=?, etiquetas_extra=?
    WHERE id=?
  `).run(
    actualizados.nombre, actualizados.lat, actualizados.lng, actualizados.direccion,
    actualizados.google_maps_url, actualizados.notas_generales,
    actualizados.probado ? 1 : 0, actualizados.pendiente_revisar ? 1 : 0,
    actualizados.visible_publico ? 1 : 0, actualizados.etiquetas_extra, req.params.id
  );
  const fila = db.prepare('SELECT * FROM restaurantes WHERE id = ?').get(req.params.id);
  res.json(construirRestaurante(fila, false));
});

// --- BORRAR restaurante (y sus categorias) ---
app.delete('/api/restaurantes/:id', requiereAuth, (req, res) => {
  db.prepare('DELETE FROM categorias WHERE restaurante_id = ?').run(req.params.id);
  db.prepare('DELETE FROM restaurantes WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// --- CATEGORIAS: añadir, editar y borrar dentro de un restaurante ---
app.post('/api/restaurantes/:id/categorias', requiereAuth, (req, res) => {
  const id = randomUUID();
  const { nombre, precio, valoracion, resena } = req.body;
  db.prepare(`INSERT INTO categorias (id, restaurante_id, nombre, precio, valoracion, resena)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, req.params.id, nombre, precio, valoracion, resena);
  res.status(201).json({ id, nombre, precio, valoracion, resena });
});

app.put('/api/categorias/:catId', requiereAuth, (req, res) => {
  const { nombre, precio, valoracion, resena } = req.body;
  db.prepare(`UPDATE categorias SET nombre=?, precio=?, valoracion=?, resena=? WHERE id=?`)
    .run(nombre, precio, valoracion, resena, req.params.catId);
  res.json({ id: req.params.catId, nombre, precio, valoracion, resena });
});

app.delete('/api/categorias/:catId', requiereAuth, (req, res) => {
  db.prepare('DELETE FROM categorias WHERE id = ?').run(req.params.catId);
  res.status(204).end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend escuchando en el puerto ${PORT}`));
