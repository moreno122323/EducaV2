const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;
const TEACHER_CODE = "EDUCA2026";
const MAX_FILE_SIZE = 100 * 1024 * 1024;

const db = new Database("educa.sqlite");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','teacher','student')),
  student_number INTEGER,
  verified INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  code TEXT NOT NULL UNIQUE,
  created_by INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(group_id,user_id),
  FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT DEFAULT '',
  file_name TEXT,
  file_path TEXT,
  file_type TEXT,
  file_size INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
if (!adminExists) {
  const hash = bcrypt.hashSync("admin123", 10);
  db.prepare("INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)")
    .run("Administrador", "admin@educa.local", hash, "admin");
  console.log("Cuenta inicial: admin@educa.local / admin123");
}

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "_" + safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: "educa-v2-session-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use("/uploads", express.static(uploadDir));
app.use(express.static(path.join(__dirname, "public")));

function auth(req,res,next){
  if(!req.session.userId) return res.status(401).json({error:"No has iniciado sesión"});
  next();
}
function getUser(id){
  return db.prepare("SELECT id,name,email,role,student_number,verified,created_at FROM users WHERE id=?").get(id);
}
function isMember(userId, groupId){
  return !!db.prepare("SELECT 1 FROM memberships WHERE user_id=? AND group_id=?").get(userId,groupId);
}
function canManageGroup(user, groupId){
  if(user.role==="admin") return true;
  const g=db.prepare("SELECT created_by FROM groups WHERE id=?").get(groupId);
  return user.role==="teacher" && g && g.created_by===user.id;
}
function makeCode(){
  let code;
  do {
    code = Math.random().toString(36).slice(2,8).toUpperCase();
  } while(db.prepare("SELECT 1 FROM groups WHERE code=?").get(code));
  return code;
}

app.get("/api/me",(req,res)=>{
  if(!req.session.userId) return res.json({user:null});
  res.json({user:getUser(req.session.userId)});
});

app.post("/api/register",(req,res)=>{
  const {name,email,password,role="student",teacherCode=""}=req.body;
  if(!name||!email||!password) return res.status(400).json({error:"Completa todos los campos"});
  if(password.length<6) return res.status(400).json({error:"La contraseña debe tener al menos 6 caracteres"});
  const cleanEmail=email.trim().toLowerCase();
  if(role==="admin") return res.status(403).json({error:"No puedes registrarte como administrador"});
  if(role==="teacher" && teacherCode!==TEACHER_CODE)
    return res.status(403).json({error:"Código de profesor incorrecto"});
  try{
    let studentNumber=null;
    if(role==="student"){
      const row=db.prepare("SELECT COALESCE(MAX(student_number),0)+1 AS n FROM users WHERE role='student'").get();
      studentNumber=row.n;
    }
    const hash=bcrypt.hashSync(password,10);
    const result=db.prepare("INSERT INTO users(name,email,password,role,student_number) VALUES(?,?,?,?,?)")
      .run(name.trim(),cleanEmail,hash,role,studentNumber);
    req.session.userId=result.lastInsertRowid;
    res.json({ok:true,user:getUser(req.session.userId)});
  }catch(e){
    if(String(e.message).includes("UNIQUE")) return res.status(409).json({error:"Ese correo ya está registrado"});
    res.status(500).json({error:"No se pudo crear la cuenta"});
  }
});

app.post("/api/login",(req,res)=>{
  const {email,password}=req.body;
  const user=db.prepare("SELECT * FROM users WHERE email=?").get((email||"").trim().toLowerCase());
  if(!user || !bcrypt.compareSync(password||"",user.password))
    return res.status(401).json({error:"Correo o contraseña incorrectos"});
  req.session.userId=user.id;
  res.json({ok:true,user:getUser(user.id)});
});

app.post("/api/logout",(req,res)=>{
  req.session.destroy(()=>res.json({ok:true}));
});

app.get("/api/groups",auth,(req,res)=>{
  const user=getUser(req.session.userId);
  let groups;
  if(user.role==="admin"){
    groups=db.prepare(`
      SELECT g.*,u.name creator,
      (SELECT COUNT(*) FROM memberships m WHERE m.group_id=g.id) member_count
      FROM groups g JOIN users u ON u.id=g.created_by ORDER BY g.id DESC
    `).all();
  }else{
    groups=db.prepare(`
      SELECT g.*,u.name creator,
      (SELECT COUNT(*) FROM memberships m WHERE m.group_id=g.id) member_count
      FROM groups g JOIN users u ON u.id=g.created_by
      JOIN memberships mm ON mm.group_id=g.id AND mm.user_id=?
      ORDER BY g.id DESC
    `).all(user.id);
  }
  res.json(groups);
});

app.post("/api/groups",auth,(req,res)=>{
  const user=getUser(req.session.userId);
  if(!["admin","teacher"].includes(user.role))
    return res.status(403).json({error:"Solo profesores y administradores pueden crear grupos"});
  const {name,description=""}=req.body;
  if(!name) return res.status(400).json({error:"Escribe el nombre del grupo"});
  const code=makeCode();
  const result=db.prepare("INSERT INTO groups(name,description,code,created_by) VALUES(?,?,?,?)")
    .run(name.trim(),description.trim(),code,user.id);
  db.prepare("INSERT INTO memberships(group_id,user_id) VALUES(?,?)").run(result.lastInsertRowid,user.id);
  res.json(db.prepare("SELECT * FROM groups WHERE id=?").get(result.lastInsertRowid));
});

app.post("/api/groups/join",auth,(req,res)=>{
  const {code}=req.body;
  const group=db.prepare("SELECT * FROM groups WHERE code=?").get((code||"").trim().toUpperCase());
  if(!group) return res.status(404).json({error:"Código de grupo no encontrado"});
  try{
    db.prepare("INSERT INTO memberships(group_id,user_id) VALUES(?,?)").run(group.id,req.session.userId);
    res.json({ok:true});
  }catch{
    res.status(409).json({error:"Ya perteneces a este grupo"});
  }
});

app.get("/api/groups/:id",auth,(req,res)=>{
  const id=Number(req.params.id);
  const user=getUser(req.session.userId);
  if(user.role!=="admin" && !isMember(user.id,id)) return res.status(403).json({error:"No perteneces a este grupo"});
  const group=db.prepare(`
    SELECT g.*,u.name creator,
    (SELECT COUNT(*) FROM memberships m WHERE m.group_id=g.id) member_count
    FROM groups g JOIN users u ON u.id=g.created_by WHERE g.id=?
  `).get(id);
  if(!group) return res.status(404).json({error:"Grupo no encontrado"});
  res.json(group);
});

app.get("/api/groups/:id/members",auth,(req,res)=>{
  const id=Number(req.params.id), user=getUser(req.session.userId);
  if(user.role!=="admin" && !isMember(user.id,id)) return res.status(403).json({error:"Sin acceso"});
  res.json(db.prepare(`
    SELECT u.id,u.name,u.email,u.role,u.student_number,m.joined_at
    FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.group_id=? ORDER BY m.joined_at
  `).all(id));
});

app.post("/api/groups/:id/members",auth,(req,res)=>{
  const id=Number(req.params.id), user=getUser(req.session.userId);
  if(!canManageGroup(user,id)) return res.status(403).json({error:"No tienes permiso"});
  const target=db.prepare("SELECT id FROM users WHERE email=?").get((req.body.email||"").trim().toLowerCase());
  if(!target) return res.status(404).json({error:"Usuario no encontrado"});
  try{
    db.prepare("INSERT INTO memberships(group_id,user_id) VALUES(?,?)").run(id,target.id);
    res.json({ok:true});
  }catch{res.status(409).json({error:"El usuario ya pertenece al grupo"});}
});

app.delete("/api/groups/:id/members/:userId",auth,(req,res)=>{
  const id=Number(req.params.id), target=Number(req.params.userId), user=getUser(req.session.userId);
  if(!canManageGroup(user,id)) return res.status(403).json({error:"No tienes permiso"});
  const group=db.prepare("SELECT created_by FROM groups WHERE id=?").get(id);
  if(group && group.created_by===target) return res.status(400).json({error:"No puedes sacar al creador del grupo"});
  db.prepare("DELETE FROM memberships WHERE group_id=? AND user_id=?").run(id,target);
  res.json({ok:true});
});

app.get("/api/groups/:id/messages",auth,(req,res)=>{
  const id=Number(req.params.id), user=getUser(req.session.userId);
  if(user.role!=="admin" && !isMember(user.id,id)) return res.status(403).json({error:"Sin acceso"});
  const messages=db.prepare(`
    SELECT m.*,u.name,u.role,u.student_number
    FROM messages m JOIN users u ON u.id=m.user_id
    WHERE m.group_id=? ORDER BY m.id ASC
  `).all(id);
  res.json(messages);
});

app.post("/api/groups/:id/messages",auth,upload.single("file"),(req,res)=>{
  const id=Number(req.params.id), user=getUser(req.session.userId);
  if(user.role!=="admin" && !isMember(user.id,id)) {
    if(req.file) fs.unlinkSync(req.file.path);
    return res.status(403).json({error:"Sin acceso"});
  }
  const text=(req.body.text||"").trim();
  if(!text && !req.file) return res.status(400).json({error:"Escribe un mensaje o adjunta un archivo"});
  const f=req.file;
  const result=db.prepare(`
    INSERT INTO messages(group_id,user_id,text,file_name,file_path,file_type,file_size)
    VALUES(?,?,?,?,?,?,?)
  `).run(id,user.id,text,f?f.originalname:null,f?"/uploads/"+f.filename:null,f?f.mimetype:null,f?f.size:null);
  res.json(db.prepare(`
    SELECT m.*,u.name,u.role,u.student_number
    FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=?
  `).get(result.lastInsertRowid));
});

app.delete("/api/messages/:id",auth,(req,res)=>{
  const m=db.prepare("SELECT * FROM messages WHERE id=?").get(Number(req.params.id));
  const user=getUser(req.session.userId);
  if(!m) return res.status(404).json({error:"Mensaje no encontrado"});
  if(user.role!=="admin" && m.user_id!==user.id) return res.status(403).json({error:"No tienes permiso"});
  if(m.file_path){
    const filename=path.basename(m.file_path);
    const fp=path.join(uploadDir,filename);
    if(fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare("DELETE FROM messages WHERE id=?").run(m.id);
  res.json({ok:true});
});

app.get("/api/admin/users",auth,(req,res)=>{
  const user=getUser(req.session.userId);
  if(user.role!=="admin") return res.status(403).json({error:"Solo administrador"});
  res.json(db.prepare("SELECT id,name,email,role,student_number,verified,created_at FROM users ORDER BY id").all());
});

app.delete("/api/admin/users/:id",auth,(req,res)=>{
  const user=getUser(req.session.userId);
  const target=Number(req.params.id);
  if(user.role!=="admin") return res.status(403).json({error:"Solo administrador"});
  if(target===user.id) return res.status(400).json({error:"No puedes eliminar tu propia cuenta"});
  db.prepare("DELETE FROM users WHERE id=?").run(target);
  res.json({ok:true});
});

app.delete("/api/groups/:id",auth,(req,res)=>{
  const id=Number(req.params.id), user=getUser(req.session.userId);
  if(!canManageGroup(user,id)) return res.status(403).json({error:"No tienes permiso"});
  db.prepare("DELETE FROM groups WHERE id=?").run(id);
  res.json({ok:true});
});

app.use((err,req,res,next)=>{
  if(err instanceof multer.MulterError && err.code==="LIMIT_FILE_SIZE")
    return res.status(413).json({error:"El archivo supera el límite de 100 MB"});
  console.error(err);
  res.status(500).json({error:"Error del servidor"});
});

app.listen(PORT,()=>console.log(`\nEDUCA V2 funcionando en http://localhost:${PORT}\nArchivos: hasta 100 MB\n`));