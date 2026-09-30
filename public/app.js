let currentUser=null;
let currentGroup=null;
let refreshTimer=null;

const $=id=>document.getElementById(id);
async function api(url,options={}){
  const response=await fetch(url,options);
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error||"Error");
  return data;
}
function show(id,yes=true){$(id).classList.toggle("hidden",!yes)}
function escapeHtml(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function formatSize(n){
  if(!n)return "";
  if(n<1024)return n+" B";
  if(n<1024*1024)return (n/1024).toFixed(1)+" KB";
  return (n/1024/1024).toFixed(1)+" MB";
}

$("tabLogin").onclick=()=>{ $("tabLogin").classList.add("active");$("tabRegister").classList.remove("active");show("loginForm");show("registerForm",false);$("authError").textContent=""};
$("tabRegister").onclick=()=>{ $("tabRegister").classList.add("active");$("tabLogin").classList.remove("active");show("registerForm");show("loginForm",false);$("authError").textContent=""};
$("regRole").onchange=()=>show("teacherCode",$("regRole").value==="teacher");

$("loginForm").onsubmit=async e=>{
  e.preventDefault(); $("authError").textContent="";
  try{await api("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:$("loginEmail").value,password:$("loginPassword").value})});await boot();}
  catch(err){$("authError").textContent=err.message}
};
$("registerForm").onsubmit=async e=>{
  e.preventDefault(); $("authError").textContent="";
  try{
    const role=$("regRole").value;
    const r=await api("/api/register",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      name:$("regName").value,email:$("regEmail").value,password:$("regPassword").value,role,teacherCode:$("teacherCode").value
    })});
    alert(role==="student" ? "Cuenta creada. Tu número de estudiante es #"+r.user.student_number : "Cuenta de profesor creada.");
    await boot();
  }catch(err){$("authError").textContent=err.message}
};

$("logoutBtn").onclick=async()=>{await api("/api/logout",{method:"POST"});location.reload()};

async function boot(){
  const r=await api("/api/me");
  currentUser=r.user;
  if(!currentUser){show("auth");show("dashboard",false);return}
  show("auth",false);show("dashboard");
  $("roleBadge").textContent=" · "+({admin:"Administrador",teacher:"Profesor",student:"Estudiante"}[currentUser.role]);
  $("userInfo").textContent=currentUser.name+(currentUser.student_number?" · #"+currentUser.student_number:"");
  show("newGroupBtn",["admin","teacher"].includes(currentUser.role));
  await loadGroups();
}
async function loadGroups(){
  const groups=await api("/api/groups");
  $("groupsList").innerHTML=groups.length?groups.map(g=>`
    <div class="group-item ${currentGroup&&currentGroup.id===g.id?"active":""}" onclick="openGroup(${g.id})">
      <b>${escapeHtml(g.name)}</b>
      <small>${g.member_count} miembro(s)</small>
    </div>`).join(""):"<p>No tienes grupos todavía.</p>";
  if(currentUser.role==="admin") showAdminButton();
}
function showAdminButton(){
  if($("adminBtn"))return;
  const b=document.createElement("button");b.id="adminBtn";b.className="secondary full";b.textContent="Panel de administrador";
  b.onclick=loadAdmin;
  $("newGroupBtn").after(b);
}
async function openGroup(id){
  currentGroup=await api("/api/groups/"+id);
  show("welcome",false);show("adminView",false);show("groupView");
  $("groupName").textContent=currentGroup.name;
  $("groupDescription").textContent=currentGroup.description||"";
  $("groupCode").textContent="Código: "+currentGroup.code;
  show("deleteGroupBtn",currentUser.role==="admin" || (currentUser.role==="teacher" && currentGroup.created_by===currentUser.id));
  $("membersPanel").classList.add("hidden");
  await loadGroups();
  await loadMessages();
}
async function loadMessages(){
  if(!currentGroup)return;
  const messages=await api("/api/groups/"+currentGroup.id+"/messages");
  $("messages").innerHTML=messages.map(m=>{
    const mine=m.user_id===currentUser.id;
    let file="";
    if(m.file_path){
      if((m.file_type||"").startsWith("image/")) file=`<a href="${m.file_path}" target="_blank"><img src="${m.file_path}" alt="imagen"></a>`;
      else file=`<a class="file" href="${m.file_path}" target="_blank" download>📎 ${escapeHtml(m.file_name)} (${formatSize(m.file_size)})</a>`;
    }
    return `<div class="message ${mine?"mine":""}">
      <div class="meta">${escapeHtml(m.name)}${m.student_number?" · #"+m.student_number:""} · ${new Date(m.created_at+"Z").toLocaleString()}</div>
      ${m.text?`<div>${escapeHtml(m.text)}</div>`:""}${file}
      ${mine||currentUser.role==="admin"?`<button class="danger" style="margin-top:7px;padding:5px 8px" onclick="deleteMessage(${m.id})">Eliminar</button>`:""}
    </div>`;
  }).join("");
  $("messages").scrollTop=$("messages").scrollHeight;
}
async function deleteMessage(id){try{await api("/api/messages/"+id,{method:"DELETE"});loadMessages()}catch(e){alert(e.message)}}

$("messageForm").onsubmit=async e=>{
  e.preventDefault();
  if(!currentGroup)return;
  const fd=new FormData();
  fd.append("text",$("messageText").value);
  if($("fileInput").files[0])fd.append("file",$("fileInput").files[0]);
  try{await api("/api/groups/"+currentGroup.id+"/messages",{method:"POST",body:fd});$("messageText").value="";$("fileInput").value="";$("selectedFile").textContent="";await loadMessages()}
  catch(e){alert(e.message)}
};
$("fileInput").onchange=()=>{$("selectedFile").textContent=$("fileInput").files[0]?$("fileInput").files[0].name:""};

$("membersBtn").onclick=async()=>{
  if(!currentGroup)return;
  const members=await api("/api/groups/"+currentGroup.id+"/members");
  const canManage=currentUser.role==="admin" || (currentUser.role==="teacher" && currentGroup.created_by===currentUser.id);
  $("membersPanel").classList.remove("hidden");
  $("membersPanel").innerHTML=`
    ${canManage?`<form id="addMemberForm" style="display:flex;flex-direction:row;margin-bottom:10px">
      <input id="memberEmail" type="email" placeholder="Correo del usuario" required><button class="primary">Agregar</button>
    </form>`:""}
    ${members.map(m=>`<div class="member"><span>${escapeHtml(m.name)} · ${m.role}${m.student_number?" · #"+m.student_number:""}<br><small>${escapeHtml(m.email)}</small></span>
      ${canManage && m.id!==currentGroup.created_by?`<button class="danger" onclick="removeMember(${m.id})">Quitar</button>`:""}</div>`).join("")}`;
  if(canManage)$("addMemberForm").onsubmit=async e=>{e.preventDefault();try{await api("/api/groups/"+currentGroup.id+"/members",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:$("memberEmail").value})});$("membersBtn").click()}catch(err){alert(err.message)}};
};
async function removeMember(id){try{await api("/api/groups/"+currentGroup.id+"/members/"+id,{method:"DELETE"});$("membersBtn").click()}catch(e){alert(e.message)}}

$("newGroupBtn").onclick=()=>{
  openModal(`<h2>Crear grupo</h2><form id="newGroupForm"><input id="newName" placeholder="Nombre del grupo" required><input id="newDesc" placeholder="Descripción"><button class="primary">Crear</button></form>`);
  $("newGroupForm").onsubmit=async e=>{e.preventDefault();try{const g=await api("/api/groups",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:$("newName").value,description:$("newDesc").value})});closeModal();await loadGroups();openGroup(g.id)}catch(err){alert(err.message)}};
};
$("joinGroupBtn").onclick=()=>{
  openModal(`<h2>Unirme a un grupo</h2><p>Pídele al profesor el código del grupo.</p><form id="joinForm"><input id="joinCode" placeholder="Código" required><button class="primary">Unirme</button></form>`);
  $("joinForm").onsubmit=async e=>{e.preventDefault();try{await api("/api/groups/join",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:$("joinCode").value})});closeModal();await loadGroups()}catch(err){alert(err.message)}};
};
$("deleteGroupBtn").onclick=async()=>{if(confirm("¿Eliminar este grupo y sus mensajes?")){try{await api("/api/groups/"+currentGroup.id,{method:"DELETE"});currentGroup=null;show("groupView",false);show("welcome");await loadGroups()}catch(e){alert(e.message)}}};

async function loadAdmin(){
  show("groupView",false);show("welcome",false);show("adminView");
  const users=await api("/api/admin/users");
  const groups=await api("/api/groups");
  $("adminStats").innerHTML=`<div class="stat"><b>${users.length}</b>Usuarios</div><div class="stat"><b>${groups.length}</b>Grupos</div>`;
  $("adminUsers").innerHTML=`<table class="admin-table"><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>#</th><th></th></tr></thead><tbody>
  ${users.map(u=>`<tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${u.role}</td><td>${u.student_number||"-"}</td><td>${u.id!==currentUser.id?`<button class="danger" onclick="deleteUser(${u.id})">Eliminar</button>`:""}</td></tr>`).join("")}
  </tbody></table>`;
}
async function deleteUser(id){if(confirm("¿Eliminar este usuario?")){try{await api("/api/admin/users/"+id,{method:"DELETE"});loadAdmin()}catch(e){alert(e.message)}}}

function openModal(html){$("modalContent").innerHTML=html;show("modal")}
function closeModal(){show("modal",false)}
$("closeModal").onclick=closeModal;
$("modal").onclick=e=>{if(e.target===$("modal"))closeModal()};

boot().catch(console.error);
setInterval(()=>{if(currentGroup && !$("groupView").classList.contains("hidden"))loadMessages().catch(()=>{})},5000);