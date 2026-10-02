const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const TEACHER_CODE = "EDUCA2026";
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// =========================
// POSTGRESQL
// =========================

if (!process.env.DATABASE_URL) {
  console.error("ERROR: Falta la variable DATABASE_URL");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// =========================
// CREAR TABLAS
// =========================

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','teacher','student')),
      student_number INTEGER,
      verified INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      code TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT DEFAULT '',
      file_name TEXT,
      file_path TEXT,
      file_type TEXT,
      file_size INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      file_name TEXT,
      file_path TEXT,
      file_type TEXT,
      file_size INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const admin = await pool.query(
    "SELECT id FROM users WHERE role='admin' LIMIT 1"
  );

  if (admin.rows.length === 0) {
    const hash = bcrypt.hashSync("admin123", 10);

    await pool.query(
      `INSERT INTO users (name,email,password,role)
       VALUES ($1,$2,$3,$4)`,
      ["Administrador", "admin@educa.local", hash, "admin"]
    );

    console.log("Cuenta inicial creada: admin@educa.local / admin123");
  }

  console.log("Base de datos PostgreSQL lista.");
}

// =========================
// ARCHIVOS
// =========================

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadDir,

  filename: (req, file, cb) => {
    const safe = file.originalname.replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    );

    cb(null, Date.now() + "_" + safe);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: MAX_FILE_SIZE
  }
});

// =========================
// MIDDLEWARE
// =========================

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      "educa-v2-session-secret-change-me",

    resave: false,

    saveUninitialized: false,

    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

app.use("/uploads", express.static(uploadDir));

app.use(express.static(path.join(__dirname, "public")));

// =========================
// FUNCIONES
// =========================

async function getUser(id) {
  const result = await pool.query(
    `SELECT
       id,
       name,
       email,
       role,
       student_number,
       verified,
       created_at
     FROM users
     WHERE id=$1`,
    [id]
  );

  return result.rows[0] || null;
}

async function isMember(userId, groupId) {
  const result = await pool.query(
    `SELECT 1
     FROM memberships
     WHERE user_id=$1
       AND group_id=$2`,
    [userId, groupId]
  );

  return result.rows.length > 0;
}

async function canManageGroup(user, groupId) {
  if (user.role === "admin") {
    return true;
  }

  const result = await pool.query(
    "SELECT created_by FROM groups WHERE id=$1",
    [groupId]
  );

  const group = result.rows[0];

  return (
    user.role === "teacher" &&
    group &&
    Number(group.created_by) === Number(user.id)
  );
}

async function makeCode() {
  let code;
  let exists = true;

  while (exists) {
    code = Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase();

    const result = await pool.query(
      "SELECT 1 FROM groups WHERE code=$1",
      [code]
    );

    exists = result.rows.length > 0;
  }

  return code;
}

function auth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({
      error: "No has iniciado sesión"
    });
  }

  next();
}

// =========================
// API ME
// =========================

app.get("/api/me", async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({
        user: null
      });
    }

    const user = await getUser(req.session.userId);

    res.json({
      user
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Error obteniendo usuario"
    });
  }
});

// =========================
// REGISTRO
// =========================

app.post("/api/register", async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role = "student",
      teacherCode = ""
    } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        error: "Completa todos los campos"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error:
          "La contraseña debe tener al menos 6 caracteres"
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    if (role === "admin") {
      return res.status(403).json({
        error:
          "No puedes registrarte como administrador"
      });
    }

    if (
      role === "teacher" &&
      teacherCode !== TEACHER_CODE
    ) {
      return res.status(403).json({
        error:
          "Código de profesor incorrecto"
      });
    }

    let studentNumber = null;

    if (role === "student") {
      const result = await pool.query(
        `SELECT
           COALESCE(MAX(student_number),0)+1 AS n
         FROM users
         WHERE role='student'`
      );

      studentNumber = Number(result.rows[0].n);
    }

    const hash = bcrypt.hashSync(password, 10);

    const result = await pool.query(
      `INSERT INTO users
       (name,email,password,role,student_number)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [
        name.trim(),
        cleanEmail,
        hash,
        role,
        studentNumber
      ]
    );

    req.session.userId = result.rows[0].id;

    const user = await getUser(
      req.session.userId
    );

    res.json({
      ok: true,
      user
    });

  } catch (error) {
    console.error(error);

    if (error.code === "23505") {
      return res.status(409).json({
        error:
          "Ese correo ya está registrado"
      });
    }

    res.status(500).json({
      error:
        "No se pudo crear la cuenta"
    });
  }
});

// =========================
// LOGIN
// =========================

app.post("/api/login", async (req, res) => {
  try {
    const {
      email,
      password
    } = req.body;

    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [
        (email || "")
          .trim()
          .toLowerCase()
      ]
    );

    const user = result.rows[0];

    if (
      !user ||
      !bcrypt.compareSync(
        password || "",
        user.password
      )
    ) {
      return res.status(401).json({
        error:
          "Correo o contraseña incorrectos"
      });
    }

    req.session.userId = user.id;

    res.json({
      ok: true,
      user: await getUser(user.id)
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        "Error iniciando sesión"
    });
  }
});

// =========================
// LOGOUT
// =========================

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({
      ok: true
    });
  });
});

// =========================
// GRUPOS
// =========================

app.get("/api/groups", auth, async (req, res) => {
  try {
    const user = await getUser(
      req.session.userId
    );

    let result;

    if (user.role === "admin") {
      result = await pool.query(`
        SELECT
          g.*,
          u.name AS creator,
          (
            SELECT COUNT(*)
            FROM memberships m
            WHERE m.group_id=g.id
          ) AS member_count
        FROM groups g
        JOIN users u
          ON u.id=g.created_by
        ORDER BY g.id DESC
      `);
    } else {
      result = await pool.query(
        `
        SELECT
          g.*,
          u.name AS creator,
          (
            SELECT COUNT(*)
            FROM memberships m
            WHERE m.group_id=g.id
          ) AS member_count
        FROM groups g
        JOIN users u
          ON u.id=g.created_by
        JOIN memberships mm
          ON mm.group_id=g.id
         AND mm.user_id=$1
        ORDER BY g.id DESC
        `,
        [user.id]
      );
    }

    res.json(result.rows);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        "Error obteniendo grupos"
    });
  }
});

app.post("/api/groups", auth, async (req, res) => {
  try {
    const user = await getUser(
      req.session.userId
    );

    if (
      !["admin", "teacher"].includes(
        user.role
      )
    ) {
      return res.status(403).json({
        error:
          "Solo profesores y administradores pueden crear grupos"
      });
    }

    const {
      name,
      description = ""
    } = req.body;

    if (!name) {
      return res.status(400).json({
        error:
          "Escribe el nombre del grupo"
      });
    }

    const code = await makeCode();

    const result = await pool.query(
      `INSERT INTO groups
       (name,description,code,created_by)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [
        name.trim(),
        description.trim(),
        code,
        user.id
      ]
    );

    await pool.query(
      `INSERT INTO memberships
       (group_id,user_id)
       VALUES ($1,$2)`,
      [
        result.rows[0].id,
        user.id
      ]
    );

    res.json(result.rows[0]);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        "No se pudo crear el grupo"
    });
  }
});

// =========================
// UNIRSE A GRUPO
// =========================

app.post(
  "/api/groups/join",
  auth,
  async (req, res) => {
    try {
      const code = (req.body.code || "")
        .trim()
        .toUpperCase();

      const result = await pool.query(
        "SELECT * FROM groups WHERE code=$1",
        [code]
      );

      const group = result.rows[0];

      if (!group) {
        return res.status(404).json({
          error:
            "Código de grupo no encontrado"
        });
      }

      try {
        await pool.query(
          `INSERT INTO memberships
           (group_id,user_id)
           VALUES ($1,$2)`,
          [
            group.id,
            req.session.userId
          ]
        );

        res.json({
          ok: true
        });

      } catch (error) {
        if (error.code === "23505") {
          return res.status(409).json({
            error:
              "Ya perteneces a este grupo"
          });
        }

        throw error;
      }

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "No se pudo unir al grupo"
      });
    }
  }
);

// =========================
// DETALLE DEL GRUPO
// =========================

app.get(
  "/api/groups/:id",
  auth,
  async (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const user = await getUser(
        req.session.userId
      );

      if (
        user.role !== "admin" &&
        !(await isMember(user.id, id))
      ) {
        return res.status(403).json({
          error:
            "No perteneces a este grupo"
        });
      }

      const result = await pool.query(
        `
        SELECT
          g.*,
          u.name AS creator,
          (
            SELECT COUNT(*)
            FROM memberships m
            WHERE m.group_id=g.id
          ) AS member_count
        FROM groups g
        JOIN users u
          ON u.id=g.created_by
        WHERE g.id=$1
        `,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error:
            "Grupo no encontrado"
        });
      }

      res.json(result.rows[0]);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Error obteniendo grupo"
      });
    }
  }
);

// =========================
// MIEMBROS
// =========================

app.get(
  "/api/groups/:id/members",
  auth,
  async (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const user = await getUser(
        req.session.userId
      );

      if (
        user.role !== "admin" &&
        !(await isMember(user.id, id))
      ) {
        return res.status(403).json({
          error: "Sin acceso"
        });
      }

      const result = await pool.query(
        `
        SELECT
          u.id,
          u.name,
          u.email,
          u.role,
          u.student_number,
          m.joined_at
        FROM memberships m
        JOIN users u
          ON u.id=m.user_id
        WHERE m.group_id=$1
        ORDER BY m.joined_at
        `,
        [id]
      );

      res.json(result.rows);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Error obteniendo miembros"
      });
    }
  }
);

// =========================
// AGREGAR MIEMBRO
// =========================

app.post(
  "/api/groups/:id/members",
  auth,
  async (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const user = await getUser(
        req.session.userId
      );

      if (
        !(await canManageGroup(
          user,
          id
        ))
      ) {
        return res.status(403).json({
          error:
            "No tienes permiso"
        });
      }

      const result = await pool.query(
        "SELECT id FROM users WHERE email=$1",
        [
          (req.body.email || "")
            .trim()
            .toLowerCase()
        ]
      );

      const target =
        result.rows[0];

      if (!target) {
        return res.status(404).json({
          error:
            "Usuario no encontrado"
        });
      }

      try {
        await pool.query(
          `INSERT INTO memberships
           (group_id,user_id)
           VALUES ($1,$2)`,
          [
            id,
            target.id
          ]
        );

        res.json({
          ok: true
        });

      } catch (error) {
        if (error.code === "23505") {
          return res.status(409).json({
            error:
              "El usuario ya pertenece al grupo"
          });
        }

        throw error;
      }

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "No se pudo agregar el usuario"
      });
    }
  }
);

// =========================
// ELIMINAR MIEMBRO
// =========================

app.delete(
  "/api/groups/:id/members/:userId",
  auth,
  async (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const target = Number(
        req.params.userId
      );

      const user = await getUser(
        req.session.userId
      );

      if (
        !(await canManageGroup(
          user,
          id
        ))
      ) {
        return res.status(403).json({
          error:
            "No tienes permiso"
        });
      }

      const result = await pool.query(
        "SELECT created_by FROM groups WHERE id=$1",
        [id]
      );

      const group =
        result.rows[0];

      if (
        group &&
        Number(group.created_by) === target
      ) {
        return res.status(400).json({
          error:
            "No puedes sacar al creador del grupo"
        });
      }

      await pool.query(
        `DELETE FROM memberships
         WHERE group_id=$1
           AND user_id=$2`,
        [id, target]
      );

      res.json({
        ok: true
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "No se pudo eliminar al miembro"
      });
    }
  }
);

// =========================
// MENSAJES
// =========================

app.get(
  "/api/groups/:id/messages",
  auth,
  async (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const user = await getUser(
        req.session.userId
      );

      if (
        user.role !== "admin" &&
        !(await isMember(user.id, id))
      ) {
        return res.status(403).json({
          error:
            "Sin acceso"
        });
      }

      const result = await pool.query(
        `
        SELECT
          m.*,
          u.name,
          u.role,
          u.student_number
        FROM messages m
        JOIN users u
          ON u.id=m.user_id
        WHERE m.group_id=$1
        ORDER BY m.id ASC
        `,
        [id]
      );

      res.json(result.rows);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Error obteniendo mensajes"
      });
    }
  }
);

// =========================
// ENVIAR MENSAJE / ARCHIVO
// =========================

app.post(
  "/api/groups/:id/messages",
  auth,
  upload.single("file"),
  async (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const user = await getUser(
        req.session.userId
      );

      if (
        user.role !== "admin" &&
        !(await isMember(user.id, id))
      ) {
        if (req.file) {
          fs.unlinkSync(
            req.file.path
          );
        }

        return res.status(403).json({
          error:
            "Sin acceso"
        });
      }

      const text =
        (req.body.text || "")
          .trim();

      if (!text && !req.file) {
        return res.status(400).json({
          error:
            "Escribe un mensaje o adjunta un archivo"
        });
      }

      const f = req.file;

      const result = await pool.query(
        `INSERT INTO messages
        (
          group_id,
          user_id,
          text,
          file_name,
          file_path,
          file_type,
          file_size
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id`,
        [
          id,
          user.id,
          text,
          f
            ? f.originalname
            : null,
          f
            ? "/uploads/" + f.filename
            : null,
          f
            ? f.mimetype
            : null,
          f
            ? f.size
            : null
        ]
      );

      const message =
        await pool.query(
          `
          SELECT
            m.*,
            u.name,
            u.role,
            u.student_number
          FROM messages m
          JOIN users u
            ON u.id=m.user_id
          WHERE m.id=$1
          `,
          [result.rows[0].id]
        );

      res.json(
        message.rows[0]
      );

    } catch (error) {
      console.error(error);

      if (
        req.file &&
        fs.existsSync(req.file.path)
      ) {
        fs.unlinkSync(
          req.file.path
        );
      }

      res.status(500).json({
        error:
          "No se pudo enviar el mensaje"
      });
    }
  }
);

// =========================
// ELIMINAR MENSAJE
// =========================

app.delete(
  "/api/messages/:id",
  auth,
  async (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const result =
        await pool.query(
          "SELECT * FROM messages WHERE id=$1",
          [id]
        );

      const m =
        result.rows[0];

      const user = await getUser(
        req.session.userId
      );

      if (!m) {
        return res.status(404).json({
          error:
            "Mensaje no encontrado"
        });
      }

      if (
        user.role !== "admin" &&
        Number(m.user_id) !==
          Number(user.id)
      ) {
        return res.status(403).json({
          error:
            "No tienes permiso"
        });
      }

      if (m.file_path) {
        const filename =
          path.basename(
            m.file_path
          );

        const fp = path.join(
          uploadDir,
          filename
        );

        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
        }
      }

      await pool.query(
        "DELETE FROM messages WHERE id=$1",
        [id]
      );

      res.json({
        ok: true
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "No se pudo eliminar el mensaje"
      });
    }
  }
);

// =========================
// ANUNCIOS
// =========================

app.get(
  "/api/announcements",
  auth,
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          SELECT
            a.id,
            a.title,
            a.content,
            a.file_name,
            a.file_path,
            a.file_type,
            a.file_size,
            a.created_at,
            u.id AS user_id,
            u.name,
            u.role
          FROM announcements a
          JOIN users u
            ON u.id=a.user_id
          ORDER BY a.id DESC
        `);

      res.json(result.rows);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Error obteniendo anuncios"
      });
    }
  }
);

// =========================
// CREAR ANUNCIO
// =========================

app.post(
  "/api/announcements",
  auth,
  upload.single("file"),
  async (req, res) => {
    try {
      const user = await getUser(
        req.session.userId
      );

      if (
        !["admin", "teacher"].includes(
          user.role
        )
      ) {
        if (req.file) {
          fs.unlinkSync(
            req.file.path
          );
        }

        return res.status(403).json({
          error:
            "Solo profesores y administradores pueden publicar anuncios"
        });
      }

      const title =
        (req.body.title || "")
          .trim();

      const content =
        (req.body.content || "")
          .trim();

      if (!title || !content) {
        if (req.file) {
          fs.unlinkSync(
            req.file.path
          );
        }

        return res.status(400).json({
          error:
            "Completa el título y el anuncio"
        });
      }

      const f = req.file;

      const result =
        await pool.query(
          `INSERT INTO announcements
          (
            user_id,
            title,
            content,
            file_name,
            file_path,
            file_type,
            file_size
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          RETURNING id`,
          [
            user.id,
            title,
            content,
            f
              ? f.originalname
              : null,
            f
              ? "/uploads/" + f.filename
              : null,
            f
              ? f.mimetype
              : null,
            f
              ? f.size
              : null
          ]
        );

      const announcement =
        await pool.query(
          `
          SELECT
            a.id,
            a.title,
            a.content,
            a.file_name,
            a.file_path,
            a.file_type,
            a.file_size,
            a.created_at,
            u.id AS user_id,
            u.name,
            u.role
          FROM announcements a
          JOIN users u
            ON u.id=a.user_id
          WHERE a.id=$1
          `,
          [result.rows[0].id]
        );

      res.json(
        announcement.rows[0]
      );

    } catch (error) {
      console.error(error);

      if (
        req.file &&
        fs.existsSync(req.file.path)
      ) {
        fs.unlinkSync(
          req.file.path
        );
      }

      res.status(500).json({
        error:
          "No se pudo publicar el anuncio"
      });
    }
  }
);

// =========================
// ELIMINAR ANUNCIO
// =========================

app.delete(
  "/api/announcements/:id",
  auth,
  async (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const user = await getUser(
        req.session.userId
      );

      const result =
        await pool.query(
          "SELECT * FROM announcements WHERE id=$1",
          [id]
        );

      const announcement =
        result.rows[0];

      if (!announcement) {
        return res.status(404).json({
          error:
            "Anuncio no encontrado"
        });
      }

      if (
        user.role !== "admin" &&
        Number(
          announcement.user_id
        ) !== Number(user.id)
      ) {
        return res.status(403).json({
          error:
            "No tienes permiso"
        });
      }

      if (
        announcement.file_path
      ) {
        const filename =
          path.basename(
            announcement.file_path
          );

        const fp = path.join(
          uploadDir,
          filename
        );

        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
        }
      }

      await pool.query(
        "DELETE FROM announcements WHERE id=$1",
        [id]
      );

      res.json({
        ok: true
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "No se pudo eliminar el anuncio"
      });
    }
  }
);

// =========================
// ADMIN - USUARIOS
// =========================

app.get(
  "/api/admin/users",
  auth,
  async (req, res) => {
    try {
      const user = await getUser(
        req.session.userId
      );

      if (user.role !== "admin") {
        return res.status(403).json({
          error:
            "Solo administrador"
        });
      }

      const result =
        await pool.query(`
          SELECT
            id,
            name,
            email,
            role,
            student_number,
            verified,
            created_at
          FROM users
          ORDER BY id
        `);

      res.json(result.rows);

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Error obteniendo usuarios"
      });
    }
  }
);

// =========================
// ADMIN - ELIMINAR USUARIO
// =========================

app.delete(
  "/api/admin/users/:id",
  auth,
  async (req, res) => {
    try {
      const user = await getUser(
        req.session.userId
      );

      const target = Number(
        req.params.id
      );

      if (user.role !== "admin") {
        return res.status(403).json({
          error:
            "Solo administrador"
        });
      }

      if (
        target === Number(user.id)
      ) {
        return res.status(400).json({
          error:
            "No puedes eliminar tu propia cuenta"
        });
      }

      await pool.query(
        "DELETE FROM users WHERE id=$1",
        [target]
      );

      res.json({
        ok: true
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "No se pudo eliminar el usuario"
      });
    }
  }
);

// =========================
// ELIMINAR GRUPO
// =========================

app.delete(
  "/api/groups/:id",
  auth,
  async (req, res) => {
    try {
      const id = Number(
        req.params.id
      );

      const user = await getUser(
        req.session.userId
      );

      if (
        !(await canManageGroup(
          user,
          id
        ))
      ) {
        return res.status(403).json({
          error:
            "No tienes permiso"
        });
      }

      await pool.query(
        "DELETE FROM groups WHERE id=$1",
        [id]
      );

      res.json({
        ok: true
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "No se pudo eliminar el grupo"
      });
    }
  }
);

// =========================
// ERRORES DE MULTER
// =========================

app.use(
  (err, req, res, next) => {
    if (
      err instanceof multer.MulterError &&
      err.code === "LIMIT_FILE_SIZE"
    ) {
      return res.status(413).json({
        error:
          "El archivo supera el límite de 100 MB"
      });
    }

    console.error(err);

    res.status(500).json({
      error:
        "Error del servidor"
    });
  }
);

// =========================
// INICIAR SERVIDOR
// =========================

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `\nEDUCA V2 funcionando en http://localhost:${PORT}`
      );

      console.log(
        "Base de datos: PostgreSQL"
      );

      console.log(
        "Archivos: hasta 100 MB\n"
      );
    });
  })
  .catch(error => {
    console.error(
      "ERROR INICIANDO LA BASE DE DATOS:"
    );

    console.error(error);

    process.exit(1);
  });