(() => {
"use strict";
const cfg = window.MATKLASS_CONFIG || {};
const ready = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
              cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes("YOUR_");
const sb = ready && window.supabase ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : null;
const $ = id => document.getElementById(id);
let student = null, attempt = null, attemptToken = null, teacherToken = sessionStorage.getItem("mk_teacher") || null;
let timerHandle = null, monitorHandle = null, activeInput = null, taskCount = 0;
const pendingSaves = new Set();
const views = ["homeView","studentWorksView","attemptView","teacherView"];
function show(id){views.forEach(v=>$(v).classList.toggle("hidden",v!==id));}
function notice(msg,type=""){const n=$("notice");n.textContent=msg;n.className="notice "+type;}
function clearNotice(){$("notice").className="notice hidden";}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function api(action,data={}) {
  if(!sb) throw new Error("Сначала укажи URL и ключ Supabase в файле config.js.");
  const {data:result,error}=await sb.functions.invoke("matklass",{body:{action,...data},headers: {
    ...(teacherToken?{"x-teacher-token":teacherToken}:{}),
    ...(attemptToken?{"x-attempt-token":attemptToken}:{})
  }});
  if(error) throw new Error(error.message || "Ошибка связи с сервером");
  if(!result?.ok) throw new Error(result?.error || "Не удалось выполнить запрос");
  return result.data;
}
function statusLabel(a){
  if(a.status==="completed" && a.manual_pending) return '<span class="status away">Ждёт проверки</span>';
  if(a.status==="completed") return '<span class="status completed">Завершил</span>';
  if(a.status==="annulled") return '<span class="status annulled">Аннулировано</span>';
  if(a.away) return '<span class="status away">Нет связи</span>';
  return '<span class="status active">Выполняет</span>';
}
function fmtDate(s){return s?new Date(s).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"}):"—";}
$("homeLink").onclick=e=>{e.preventDefault();show("homeView");};
$("studentHomeBtn").onclick=()=>{show("homeView");};
$("studentEntryForm").onsubmit=async e=>{
  e.preventDefault(); clearNotice();
  student={first:$("studentFirst").value.trim(),last:$("studentLast").value.trim()};
  if(!student.first||!student.last)return;
  try{
    const data=await api("student_list");
    $("studentGreeting").textContent=`Здравствуйте, ${student.first} ${student.last}`;
    $("studentWorks").innerHTML=data.works.length?data.works.map(w=>`<article class="work-card"><h3>${esc(w.title)}</h3><p>${esc(w.section)} · ${esc(w.topic)} · ${esc(w.difficulty)}</p><p>${w.duration_minutes} минут</p><button class="primary start-work" data-id="${w.id}">Начать работу</button></article>`).join(""):"<p class='muted'>Сейчас нет доступных работ.</p>";
    $("studentWorks").querySelectorAll(".start-work").forEach(b=>b.onclick=()=>startWork(b.dataset.id));
    show("studentWorksView");
  }catch(err){notice(err.message,"error");}
};
$("teacherEntryForm").onsubmit=async e=>{
  e.preventDefault(); clearNotice();
  const code=$("teacherCode").value.trim();
  if(!/^\d{5}$/.test(code)){notice("Код должен состоять ровно из пяти цифр.","error");return;}
  try{const d=await api("teacher_login",{code});teacherToken=d.token;sessionStorage.setItem("mk_teacher",teacherToken);await openTeacher();}
  catch(err){notice(err.message,"error");}
};
async function startWork(id){
  try{
    const d=await api("student_start",{work_id:id,student_name:`${student.first} ${student.last}`});
    attempt=d.attempt;attemptToken=d.token;
    $("attemptTitle").textContent=d.work.title;$("attemptStudent").textContent=`${student.first} ${student.last}`;
    $("questionList").innerHTML=d.tasks.map((t,i)=>`<article class="question panel" data-task="${t.id}"><h3>${i+1}. ${esc(t.prompt)} <small class="muted">(${t.points} б.)</small></h3>${t.answer_type==="choice"?(t.options||[]).map(o=>`<label class="choice-option"><input type="radio" name="q_${t.id}" data-task="${t.id}" value="${esc(o)}"><span>${esc(o)}</span></label>`).join(""):`<label>${t.answer_type==="manual"?"Развёрнутое решение":"Твой ответ"}<textarea class="answer-input" rows="${t.answer_type==="manual"?5:2}" data-task="${t.id}" placeholder="Введи ответ"></textarea></label>`}</article>`).join("");
    $("questionList").querySelectorAll("textarea,input").forEach(el=>{el.addEventListener("focus",()=>activeInput=el);el.addEventListener("change",()=>saveAnswer(el));el.addEventListener("blur",()=>saveAnswer(el));});
    $("attemptStatus").className="notice hidden";
    show("attemptView");startClock(d.attempt.ends_at);beginHeartbeat();
  }catch(err){notice(err.message,"error");}
}
async function saveAnswer(el){
  if(!attemptToken||!attempt)return;
  const taskId=el.dataset.task || el.name?.replace("q_","");
  if(!taskId)return;
  const value=el.type==="radio"?el.value:(el.type==="radio"?"":el.value);
  if(el.type==="radio"&&!el.checked)return;
  const savePromise=api("student_answer",{task_id:taskId,answer:value});
  pendingSaves.add(savePromise);
  try{await savePromise;}
  catch(err){if(err.message.includes("аннулир"))annulLocal(err.message);}
  finally{pendingSaves.delete(savePromise);}
}
function startClock(endsAt){
  clearInterval(timerHandle);
  const tick=()=>{const ms=Math.max(0,new Date(endsAt).getTime()-Date.now());const sec=Math.ceil(ms/1000);$("timer").textContent=`${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;if(sec<=0){clearInterval(timerHandle);finishAttempt(true);}};
  tick();timerHandle=setInterval(tick,500);
}
let heartbeatHandle=null,hiddenAt=null;
function beginHeartbeat(){
  clearInterval(heartbeatHandle);
  heartbeatHandle=setInterval(async()=>{if(!attemptToken||document.hidden)return;try{const d=await api("student_ping");if(d.status==="annulled")annulLocal("Попытка аннулирована: отсутствие активности более 5 секунд.");}catch(e){/* сервер проверит пропуск heartbeat */}},2000);
}
document.addEventListener("visibilitychange",async()=>{
  if(!attemptToken)return;
  if(document.hidden){hiddenAt=Date.now();try{await api("student_leave");}catch(e){}}
  else{try{const d=await api("student_ping");if(d.status==="annulled")annulLocal("Попытка аннулирована: возвращение произошло позже допустимых 5 секунд.");}catch(e){annulLocal("Не удалось подтвердить активность. Обратись к преподавателю.");}}
});
window.addEventListener("pagehide",()=>{if(attemptToken&&navigator.sendBeacon){/* heartbeat timeout is the fallback when the page closes */}});
function annulLocal(msg){clearInterval(timerHandle);clearInterval(heartbeatHandle);$("attemptStatus").textContent=msg;$("attemptStatus").className="notice error";$("finishBtn").disabled=true;}
async function finishAttempt(auto=false){
  if(!attemptToken)return;
  if(!auto&&!confirm("Завершить работу? После завершения изменить ответы будет нельзя."))return;
  try{
    if(pendingSaves.size) await Promise.allSettled([...pendingSaves]);
    const d=await api("student_finish");
    clearInterval(timerHandle);clearInterval(heartbeatHandle);attemptToken=null;$("finishBtn").disabled=true;
    $("attemptStatus").textContent=d.status==="annulled"?"Попытка аннулирована.":(d.manual_pending?"Работа завершена. Развёрнутые ответы ожидают проверки преподавателя.":"Работа завершена. Результат сохранён.");
    $("attemptStatus").className="notice "+(d.status==="annulled"?"error":"success");
  }catch(err){annulLocal(err.message);}
}
$("finishBtn").onclick=()=>finishAttempt(false);
function addTask(){
  const tpl=$("taskTemplate").content.cloneNode(true),node=tpl.querySelector(".task-editor");taskCount++;
  node.querySelector(".task-number").textContent=taskCount;
  node.querySelector(".remove-task").onclick=()=>{node.remove();renumberTasks();};
  const type=node.querySelector(".task-type"),wrap=node.querySelector(".options-wrap"),tol=node.querySelector(".numeric-wrap");
  type.onchange=()=>{wrap.classList.toggle("hidden",type.value!=="choice");tol.classList.toggle("hidden",type.value!=="numeric");};
  node.querySelectorAll("textarea,input").forEach(el=>el.addEventListener("focus",()=>activeInput=el));
  $("taskEditor").appendChild(node);renumberTasks();
}
function renumberTasks(){[...$("taskEditor").children].forEach((n,i)=>n.querySelector(".task-number").textContent=i+1);}
$("addTaskBtn").onclick=addTask;addTask();
$("mathKeyboard").onclick=e=>{
  const b=e.target.closest("[data-insert]");if(!b)return;
  if(!activeInput){notice("Сначала нажми на поле условия или ответа.","error");return;}
  const start=activeInput.selectionStart??activeInput.value.length,end=activeInput.selectionEnd??start;
  const val=b.dataset.insert,old=activeInput.value;
  activeInput.value=old.slice(0,start)+val+old.slice(end);activeInput.focus();
  const pos=start+val.length;activeInput.setSelectionRange(pos,pos);
};
function calcSafe(expr, n){
  const tokens=String(expr).match(/\d+(?:\.\d+)?|n|[()+\-*/^]/gi)||[];
  if(tokens.join("")!==String(expr).replace(/\s+/g,""))throw new Error("Формула содержит недопустимые символы.");
  let i=0;
  function primary(){
    const t=tokens[i++];
    if(t==="n")return n;
    if(t==="+")return primary();
    if(t==="-")return -primary();
    if(t==="("){const v=add();if(tokens[i++]!==")")throw new Error("Проверь скобки в формуле.");return v;}
    const v=Number(t);if(!Number.isFinite(v))throw new Error("Ошибка формулы.");return v;
  }
  function power(){let v=primary();if(tokens[i]==="^"){i++;v=Math.pow(v,power());}return v;}
  function mul(){let v=power();while(tokens[i]==="*"||tokens[i]==="/"){const op=tokens[i++],r=power();v=op==="*"?v*r:v/r;}return v;}
  function add(){let v=mul();while(tokens[i]==="+"||tokens[i]==="-"){const op=tokens[i++],r=mul();v=op==="+"?v+r:v-r;}return v;}
  const out=add();if(i!==tokens.length||!Number.isFinite(out))throw new Error("Формула некорректна или даёт бесконечность.");return Number(out.toFixed(8));
}
function templateData(){
  return {title:$("tplTitle").value.trim(),prompt_pattern:$("tplPrompt").value.trim(),answer_formula:$("tplFormula").value.trim(),min_n:Number($("tplMin").value),max_n:Number($("tplMax").value),points:Number($("tplPoints").value)||1,section:$("workSection").value,topic:$("workTopic").value||"Шаблон"};
}
$("saveTemplateBtn").onclick=async()=>{
  try{const t=templateData();if(!t.title||!t.prompt_pattern.includes("{n}")||!t.answer_formula||!Number.isFinite(t.min_n)||!Number.isFinite(t.max_n)||t.min_n>t.max_n)throw new Error("Заполни название, условие с {n}, формулу и правильный диапазон.");
    calcSafe(t.answer_formula,t.min_n);
    await api("teacher_save_template",{template:t});notice("Шаблон сохранён.","success");await loadTemplates();
  }catch(e){notice(e.message,"error");}
};
$("generateTemplateBtn").onclick=()=>{
  try{const t=templateData();if(!t.prompt_pattern.includes("{n}")||!t.answer_formula||t.min_n>t.max_n)throw new Error("Заполни условие, формулу и диапазон.");
    const min=Math.ceil(t.min_n),max=Math.floor(t.max_n);if(max<min)throw new Error("Диапазон должен содержать целые числа.");
    const n=Math.floor(Math.random()*(max-min+1))+min,answer=calcSafe(t.answer_formula,n);
    addTask();
    const node=$("taskEditor").lastElementChild;
    node.querySelector(".task-prompt").value=t.prompt_pattern.replaceAll("{n}",String(n));
    node.querySelector(".task-type").value="numeric";node.querySelector(".task-type").dispatchEvent(new Event("change"));
    node.querySelector(".task-correct").value=String(answer);node.querySelector(".task-points").value=t.points;
    node.querySelector(".task-tolerance").value="0.001";
    notice(`Создан вариант: n = ${n}. Условие и ответ добавлены в работу.`, "success");
  }catch(e){notice(e.message,"error");}
};
$("savedTemplates").onchange=async()=>{
  const id=$("savedTemplates").value;if(!id)return;
  try{const d=await api("teacher_templates");const t=d.templates.find(x=>x.id===id);if(!t)return;
    $("tplTitle").value=t.title;$("tplPrompt").value=t.prompt_pattern;$("tplFormula").value=t.answer_formula;
    $("tplMin").value=t.min_n;$("tplMax").value=t.max_n;$("tplPoints").value=t.points;$("workSection").value=t.section;$("workTopic").value=t.topic;
  }catch(e){notice(e.message,"error");}
};
async function loadTemplates(){
  if(!teacherToken)return;
  try{const d=await api("teacher_templates");$("savedTemplates").innerHTML='<option value="">Выбрать сохранённый шаблон</option>'+d.templates.map(t=>`<option value="${t.id}">${esc(t.title)}</option>`).join("");}
  catch(e){notice(e.message,"error");}
}
async function loadReviews(){
  if(!teacherToken)return;
  try{
    const d=await api("teacher_review_list");
    $("reviewArea").innerHTML=d.attempts.length?d.attempts.map(a=>`<article class="panel review-card" data-attempt="${a.id}"><h3>${esc(a.student_name)} · ${esc(a.work_title)}</h3><p class="muted">Автоматически начислено: ${a.score}/${a.max_score}</p>${a.tasks.map(t=>`<div class="review-task"><strong>${esc(t.prompt)}</strong><p>Ответ ученика: ${esc(a.answers[t.id]||"Нет ответа")}</p><p class="muted">Критерий преподавателя: ${esc(t.correct_answer)}</p><label>Баллы (максимум ${t.points})<input class="review-score" data-task="${t.id}" type="number" min="0" max="${t.points}" value="${a.manual_scores[t.id]??0}"></label></div>`).join("")}<label>Комментарий ученику<textarea class="review-comment" rows="2"></textarea></label><button class="primary save-review">Сохранить оценку</button></article>`).join(""):"<p class='muted'>Нет ответов, ожидающих ручной проверки.</p>";
    $("reviewArea").querySelectorAll(".save-review").forEach(b=>b.onclick=async()=>{
      const card=b.closest(".review-card"),scores={};card.querySelectorAll(".review-score").forEach(x=>scores[x.dataset.task]=Number(x.value));
      try{await api("teacher_grade_manual",{attempt_id:card.dataset.attempt,scores,comment:card.querySelector(".review-comment").value});notice("Ручная проверка сохранена.","success");await loadReviews();await loadMonitor();}
      catch(e){notice(e.message,"error");}
    });
  }catch(e){notice(e.message,"error");}
}
$("createWorkForm").onsubmit=async e=>{
  e.preventDefault();
  const tasks=[...$("taskEditor").querySelectorAll(".task-editor")].map(n=>({
    prompt:n.querySelector(".task-prompt").value.trim(),
    answer_type:n.querySelector(".task-type").value,
    options:n.querySelector(".task-options").value.split("\n").map(x=>x.trim()).filter(Boolean),
    correct_answer:n.querySelector(".task-correct").value.trim(),
    tolerance:Number(n.querySelector(".task-tolerance").value)||0,
    points:Number(n.querySelector(".task-points").value)||1
  }));
  if(!tasks.length||tasks.some(t=>!t.prompt||!t.correct_answer)){notice("Добавь задания и правильные ответы.","error");return;}
  if(tasks.some(t=>t.answer_type==="choice"&&(!t.options.length||!t.options.includes(t.correct_answer)))){notice("Для тестового задания правильный ответ должен совпадать с одним из вариантов.","error");return;}
  try{
    await api("teacher_create_work",{work:{title:$("workTitle").value,section:$("workSection").value,topic:$("workTopic").value,difficulty:$("workDifficulty").value,duration_minutes:Number($("workDuration").value),mode:$("workMode").value,published:$("publishWork").checked},tasks});
    $("createWorkForm").reset();$("taskEditor").innerHTML="";addTask();notice("Работа сохранена.","success");await loadTeacherWorks();await loadMonitor();
  }catch(err){notice(err.message,"error");}
};
async function openTeacher(){show("teacherView");await loadMonitor();await loadTeacherWorks();await loadTemplates();await loadReviews();clearInterval(monitorHandle);monitorHandle=setInterval(loadMonitor,2200);}
$("teacherLogout").onclick=()=>{teacherToken=null;sessionStorage.removeItem("mk_teacher");clearInterval(monitorHandle);show("homeView");};
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===b));
  document.querySelectorAll(".tab-content").forEach(x=>x.classList.add("hidden"));
  $("tab-"+b.dataset.tab).classList.remove("hidden");
  if(b.dataset.tab==="review")loadReviews();
});
$("refreshMonitor").onclick=loadMonitor;
async function loadMonitor(){
  if(!teacherToken)return;
  try{
    const d=await api("teacher_dashboard");
    $("stats").innerHTML=[["active","Выполняют"],["completed","Завершили"],["annulled","Аннулированы"],["manual","Ждут проверки"]].map(([k,l])=>`<div class="stat"><strong>${d.counts[k]||0}</strong><span>${l}</span></div>`).join("");
    $("monitorRows").innerHTML=d.attempts.length?d.attempts.map(a=>`<tr><td>${esc(a.student_name)}</td><td>${esc(a.work_title)}</td><td>${fmtDate(a.started_at)}</td><td>${statusLabel(a)}</td><td>${a.score==null?"—":`${a.score}/${a.max_score}`}</td></tr>`).join(""):"<tr><td colspan='5'>Пока никто не начал работу.</td></tr>";
  }catch(e){if(e.message.toLowerCase().includes("сесс")){teacherToken=null;sessionStorage.removeItem("mk_teacher");} }
}
async function loadTeacherWorks(){
  if(!teacherToken)return;
  try{
    const d=await api("teacher_works");
    $("teacherWorks").innerHTML=d.works.length?d.works.map(w=>`<article class="work-card"><h3>${esc(w.title)}</h3><p>${esc(w.section)} · ${esc(w.topic)} · ${w.duration_minutes} мин.</p><p>${w.published?"Доступна ученикам":"Черновик"}</p><div class="actions"><button class="secondary small publish-toggle" data-id="${w.id}" data-pub="${!w.published}">${w.published?"Скрыть":"Опубликовать"}</button> <button class="ghost small delete-work" data-id="${w.id}">Удалить</button></div></article>`).join(""):"<p class='muted'>Работ пока нет.</p>";
    $("teacherWorks").querySelectorAll(".publish-toggle").forEach(b=>b.onclick=async()=>{try{await api("teacher_publish",{work_id:b.dataset.id,published:b.dataset.pub==="true"});await loadTeacherWorks();}catch(e){notice(e.message,"error");}});
    $("teacherWorks").querySelectorAll(".delete-work").forEach(b=>b.onclick=async()=>{if(!confirm("Удалить работу и связанные попытки?"))return;try{await api("teacher_delete_work",{work_id:b.dataset.id});await loadTeacherWorks();await loadMonitor();}catch(e){notice(e.message,"error");}});
  }catch(e){notice(e.message,"error");}
}
if(!ready){notice("Перед запуском подключи Supabase: открой config.js и вставь URL проекта и публичный ключ. Не вставляй secret/service_role key.","error");}
if(teacherToken){openTeacher().catch(()=>{teacherToken=null;sessionStorage.removeItem("mk_teacher");});}
})();