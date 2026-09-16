(function(){
  "use strict";

  var TYPES = ["meals","sleep","supplements","medical"];
  var CAT_NAME = {sleep:"Sueño", nutrition:"Nutrición", supplements:"Suplementos", medical:"Médico"};

  var state = {meals:[], sleep:[], supplements:[], medical:[]};
  var db = null;
  var charts = {};

  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function fmtDate(iso){
    if(!iso) return "";
    var d = new Date(iso + "T00:00:00");
    if(isNaN(d)) return iso;
    return d.toLocaleDateString("es-ES", {day:"numeric", month:"short"});
  }
  function daysAgo(n){
    var d = new Date();
    d.setDate(d.getDate()-n);
    return d.toISOString().slice(0,10);
  }
  function css(varName){
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }
  function showToast(msg){
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(showToast._h);
    showToast._h = setTimeout(function(){ t.classList.remove("show"); }, 2200);
  }
  function uid(){
    return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  }

  // ---------- storage layer ----------
  // Fuera del entorno de Claude (window.claude no existe) la app funciona
  // en modo local: los datos se guardan en localStorage de este navegador.
  var LOCAL_KEY_PREFIX = "bequitacora_vital_";
  function localGetAll(type){
    try{
      var raw = localStorage.getItem(LOCAL_KEY_PREFIX+type);
      return raw ? JSON.parse(raw) : [];
    }catch(e){ return []; }
  }
  function localSetAll(type, arr){
    try{ localStorage.setItem(LOCAL_KEY_PREFIX+type, JSON.stringify(arr)); }catch(e){}
  }

  function addEntry(type, data){
    data.createdAt = new Date().toISOString();
    if(db){
      return db.collection(type).add(data).catch(function(err){
        console.error("db add failed", err);
        showToast("No se pudo guardar (" + (err && err.code || "error") + ")");
      });
    } else {
      var arr = localGetAll(type);
      var doc = Object.assign({id: uid()}, data);
      arr.push(doc);
      localSetAll(type, arr);
      state[type] = arr.slice().sort(function(a,b){ return (b.date||"").localeCompare(a.date||""); });
      renderAll();
      return Promise.resolve();
    }
  }

  function deleteEntry(type, id){
    if(db){
      return db.collection(type).doc(id).delete().catch(function(err){
        console.error("db delete failed", err);
        showToast("No se pudo borrar");
      });
    } else {
      var arr = localGetAll(type).filter(function(d){ return d.id !== id; });
      localSetAll(type, arr);
      state[type] = arr.slice().sort(function(a,b){ return (b.date||"").localeCompare(a.date||""); });
      renderAll();
      return Promise.resolve();
    }
  }

  function resolveMedical(id){
    if(db){
      return db.collection("medical").doc(id).update({flag:false}).catch(function(err){
        console.error("update failed", err);
      });
    } else {
      var arr = localGetAll("medical").map(function(d){
        if(d.id===id) d.flag = false;
        return d;
      });
      localSetAll("medical", arr);
      state.medical = arr;
      renderAll();
      return Promise.resolve();
    }
  }

  async function initStore(){
    // "claude" solo existe cuando esta página se abre dentro de un Artifact
    // de Claude. En un navegador normal, este bloque falla silenciosamente
    // y la app sigue en modo local con localStorage.
    try{
      db = await claude.use("db");
    }catch(e){ db = null; }

    if(!db){
      TYPES.forEach(function(t){
        state[t] = localGetAll(t).sort(function(a,b){ return (b.date||"").localeCompare(a.date||""); });
      });
      renderAll();
      return;
    }

    TYPES.forEach(function(type){
      var q = db.collection(type).orderBy("date","desc").limit(500);
      q.onSnapshot(function(snap){
        state[type] = snap.docs.map(function(d){
          return Object.assign({id:d.id}, d.data());
        });
        renderAll();
      }, function(err){
        console.error(type, "snapshot error", err);
        showToast("Sincronización no disponible, usando modo local");
        state[type] = localGetAll(type);
        renderAll();
      });
    });
  }

  // ---------- tabs ----------
  function switchTab(view){
    document.querySelectorAll("nav.tabs button").forEach(function(b){ b.setAttribute("aria-selected", String(b.dataset.view===view)); });
    document.querySelectorAll("section.view").forEach(function(s){ s.classList.remove("active"); });
    document.getElementById("view-"+view).classList.add("active");
    if(view === "stats") setTimeout(renderCharts, 30);
  }
  document.querySelectorAll("nav.tabs button").forEach(function(btn){
    btn.addEventListener("click", function(){ switchTab(btn.dataset.view); });
  });
  document.getElementById("goMejoras").addEventListener("click", function(){ switchTab("mejoras"); });

  document.querySelectorAll(".subtabs button").forEach(function(btn){
    btn.addEventListener("click", function(){
      document.querySelectorAll(".subtabs button").forEach(function(b){ b.setAttribute("aria-selected","false"); });
      btn.setAttribute("aria-selected","true");
      document.querySelectorAll(".entry-form").forEach(function(f){ f.classList.remove("active"); });
      document.getElementById("form-"+btn.dataset.form).classList.add("active");
    });
  });

  document.querySelectorAll('input[type="range"]').forEach(function(r){
    var out = r.nextElementSibling;
    r.addEventListener("input", function(){ out.textContent = r.value; });
  });

  document.querySelectorAll('input[type="date"]').forEach(function(i){ i.value = todayISO(); });

  // ---------- forms ----------
  document.querySelectorAll("form.entry").forEach(function(form){
    form.addEventListener("submit", function(e){
      e.preventDefault();
      var type = form.dataset.type;
      var data = {};
      new FormData(form).forEach(function(v,k){ data[k] = v; });
      data.flag = !!form.querySelector('[name="flag"]') && form.querySelector('[name="flag"]').checked;
      if(data.quality) data.quality = Number(data.quality);
      if(data.hours) data.hours = Number(data.hours);
      addEntry(type, data).then(function(){
        showToast("Guardado");
        form.reset();
        form.querySelectorAll('input[type="date"]').forEach(function(i){ i.value = todayISO(); });
        form.querySelectorAll('input[type="range"]').forEach(function(r){ r.value=3; r.nextElementSibling.textContent="3"; });
      });
    });
  });

  // ---------- scoring ----------
  function inWindow(dateStr, fromISO){
    return dateStr && dateStr >= fromISO;
  }

  function computeScores(days){
    var from = daysAgo(days-1);
    var meals = state.meals.filter(function(m){ return inWindow(m.date, from); });
    var sleeps = state.sleep.filter(function(s){ return inWindow(s.date, from); });
    var sups = state.supplements.filter(function(s){ return inWindow(s.date, from); });
    var meds = state.medical.filter(function(m){ return inWindow(m.date, from); });

    var sleepScore = null;
    if(sleeps.length){
      var sTotal = 0;
      sleeps.forEach(function(s){
        var hours = Number(s.hours)||0;
        var quality = Number(s.quality)||3;
        sTotal += Math.min(hours/8,1)*70 + (quality/5)*30;
      });
      sleepScore = Math.round(sTotal/sleeps.length);
    }

    var nutritionScore = null;
    if(meals.length){
      var qTotal = 0;
      meals.forEach(function(m){ qTotal += (Number(m.quality)||3)/5*100; });
      var avgQ = qTotal/meals.length;
      var expected = days*2.2;
      var consistency = Math.min(meals.length/expected, 1);
      nutritionScore = Math.round(avgQ*0.75 + consistency*100*0.25);
    }

    var supplementScore = null;
    if(state.supplements.length){
      var uniqueDays = {};
      sups.forEach(function(s){ uniqueDays[s.date] = true; });
      supplementScore = Math.round(Math.min(Object.keys(uniqueDays).length/days,1)*100);
    }

    var openFlags = state.medical.filter(function(m){ return m.flag; }).length;
    var medicalScore = 100 - Math.min(openFlags*20,60);
    var recentMed = state.medical.some(function(m){ return inWindow(m.date, daysAgo(179)); });
    if(!recentMed && state.medical.length===0){
      medicalScore = 70;
    } else if(!recentMed){
      medicalScore -= 15;
    }
    medicalScore = Math.max(0, Math.min(100, medicalScore));

    var parts = [
      {v:sleepScore, w:0.30},
      {v:nutritionScore, w:0.30},
      {v:supplementScore, w:0.15},
      {v:medicalScore, w:0.25}
    ];
    var wSum=0, vSum=0;
    parts.forEach(function(p){ if(p.v!==null){ wSum+=p.w; vSum+=p.v*p.w; } });
    var overall = wSum>0 ? Math.round(vSum/wSum) : null;

    return {
      overall: overall,
      sleep: sleepScore, nutrition: nutritionScore,
      supplements: supplementScore, medical: medicalScore,
      openFlags: openFlags, mealsCount: meals.length, sleepCount: sleeps.length,
      supCount: sups.length, medCount: meds.length, days: days
    };
  }

  function scoreTone(v){
    if(v===null) return {cls:"none", label:"Sin datos"};
    if(v>=75) return {cls:"ok", label:"Bien"};
    if(v>=50) return {cls:"warn", label:"Mejorable"};
    return {cls:"bad", label:"Atención"};
  }
  function tierFor(v){
    if(v===null) return "none";
    if(v>=75) return "high";
    if(v>=50) return "mid";
    return "low";
  }

  // ---------- render: dashboard ----------
  function renderGauge(scores){
    var v = scores.overall;
    var pct = v===null ? 0 : v;
    var circumference = Math.PI*90;
    var frac = pct/100;
    var arc = document.getElementById("gaugeArc");
    arc.setAttribute("stroke-dasharray", (circumference*frac).toFixed(1) + " " + circumference.toFixed(1));
    var tone = scoreTone(v);
    document.getElementById("gaugeNum").textContent = v===null ? "--" : v;
    var pill = document.getElementById("gaugePill");
    pill.className = "tag " + tone.cls;
    pill.textContent = v===null ? "Añade tus primeros registros" : tone.label;
    document.getElementById("gaugeSub").textContent = v===null
      ? "Registra comidas, sueño, suplementos e informes para calcular tu score."
      : "Basado en tus últimos " + scores.days + " días: sueño, nutrición, suplementación y seguimiento médico.";
  }

  function renderCatTiles(scores){
    var cats = [
      {key:"sleep", label:"Sueño", badge:"SUE", v:scores.sleep, detail: scores.sleepCount + " registro" + (scores.sleepCount===1?"":"s")},
      {key:"nutrition", label:"Nutrición", badge:"NUT", v:scores.nutrition, detail: scores.mealsCount + " comida" + (scores.mealsCount===1?"":"s")},
      {key:"supplements", label:"Suplementos", badge:"SUP", v:scores.supplements, detail: scores.supCount + " registro" + (scores.supCount===1?"":"s")},
      {key:"medical", label:"Médico", badge:"MED", v:scores.medical, detail: scores.openFlags>0 ? scores.openFlags+" pendiente"+(scores.openFlags===1?"":"s") : "Sin pendientes"}
    ];
    var wrap = document.getElementById("catTiles");
    wrap.innerHTML = "";
    cats.forEach(function(c){
      var tone = scoreTone(c.v);
      var el = document.createElement("div");
      el.className = "cat-tile";
      el.innerHTML =
        '<div class="top"><span class="name"><span class="badge">'+c.badge+'</span>'+c.label+'</span>' +
        '<span class="score num">'+(c.v===null?"--":c.v)+'</span></div>' +
        '<div class="bar"><span style="width:'+(c.v||0)+'%"></span></div>' +
        '<div class="top"><span class="note">'+c.detail+'</span><span class="tag '+tone.cls+'">'+tone.label+'</span></div>';
      wrap.appendChild(el);
    });
  }

  function renderBanner(scores){
    var b = document.getElementById("alertBanner");
    if(scores.openFlags>0){
      var pending = state.medical.filter(function(m){ return m.flag; });
      b.innerHTML = '<div class="banner" style="margin-top:14px;"><div><strong>'+scores.openFlags+'</strong> informe(s) médico(s) pendientes de seguimiento: ' +
        pending.slice(0,3).map(function(p){ return '"'+(p.title||p.type)+'" ('+fmtDate(p.date)+')'; }).join(", ") +
        '.</div></div>';
    } else {
      b.innerHTML = "";
    }
  }

  var TIP_BANK = [
    "Mantener un horario de sueño constante importa más para la calidad del descanso que las horas totales.",
    "Incluir proteína y vegetales en al menos dos comidas al día ayuda a estabilizar la energía.",
    "La luz natural por la mañana regula tu ritmo circadiano y facilita dormir mejor por la noche.",
    "Beber suficiente agua a lo largo del día mejora la concentración y reduce la fatiga.",
    "Anotar cómo te sientes después de cada comida ayuda a detectar patrones de energía o malestar.",
    "Un paseo breve después de comer favorece la digestión y regula la glucosa.",
    "La constancia importa más que la perfección: un registro diario breve es mejor que uno perfecto ocasional."
  ];

  var TIPS_LIBRARY = {
    sleep: {
      none: ["Aún no tienes registros de sueño. Anota la hora a la que te acuestas y te levantas: es la base para tu score de descanso.", "Una nota rápida cada mañana (horas dormidas y cómo te sientes) ya aporta datos útiles."],
      low: ["Prioriza dormir entre 7 y 9 horas: es el rango asociado a mejor recuperación física y cognitiva.", "Evita pantallas al menos 30 minutos antes de acostarte; la luz interfiere con la melatonina.", "Mantén una hora fija de acostarte y despertar, incluso los fines de semana."],
      mid: ["Revisa si te despiertas durante la noche y anótalo en las notas para detectar patrones.", "Evita cafeína después de media tarde: puede afectar la calidad del sueño hasta 6 horas después.", "Una rutina relajante antes de dormir puede subir tu puntuación de calidad."],
      high: ["Tu descanso está en buena forma. Mantén la constancia en horarios, es lo que más lo sostiene.", "Sigue registrando: te ayudará a detectar cambios antes de que se noten en el día a día."]
    },
    nutrition: {
      none: ["Registra tu primera comida para empezar a construir tu score de nutrición.", "No hace falta ser exhaustivo: una frase describiendo qué has comido ya sirve."],
      low: ["Incluye una fuente de proteína y vegetales en al menos dos comidas al día.", "Evita saltarte comidas: genera bajones de energía y peor relación con la comida más tarde.", "Anota cómo te sientes después de comer para identificar qué te sienta mejor."],
      mid: ["Vas por buen camino. Prueba a variar más los alimentos a lo largo de la semana.", "Hidratarte bien entre comidas ayuda a diferenciar hambre real de sed."],
      high: ["Tu alimentación está bien encaminada. Sigue registrando para mantener la constancia.", "Prueba a anotar también el horario de las comidas para ver patrones de energía."]
    },
    supplements: {
      none: ["Si tomas algún suplemento, regístralo aquí para hacer seguimiento de tu constancia.", "Si no tomas suplementos, tranquilo: esta categoría no penaliza tu score general."],
      low: ["Vincula tu suplemento a un hábito ya establecido, como justo después de desayunar.", "Deja el bote a la vista o pon un recordatorio a una hora fija del día."],
      mid: ["Vas ganando constancia. Intenta mantener el mismo horario cada día.", "Revisa si aún tiene sentido la dosis o el suplemento que estás tomando."],
      high: ["Muy buena constancia con tu suplementación. Sigue así.", "Aprovecha para anotar si notas algún efecto, positivo o negativo."]
    },
    medical: {
      none: ["Registra tu último informe médico o analítica para tener un histórico accesible.", "Basta con anotar fecha, tipo y una nota con lo relevante; no hace falta subir documentos."],
      low: ["Tienes informes pendientes de seguimiento: considera agendar cita si no lo has hecho.", "Anota cualquier síntoma o cambio relevante, ayuda a dar contexto en tu próxima consulta."],
      mid: ["Sin pendientes urgentes, pero conviene no dejar pasar demasiado tiempo entre revisiones.", "Si tomas medicación, anótalo también aquí para tener el histórico completo."],
      high: ["Buen seguimiento médico. Una revisión general anual es una buena práctica preventiva.", "Sigue registrando resultados de analíticas para ver tendencias a largo plazo."]
    }
  };

  function renderTips(scores){
    var cats = [
      {key:"sleep", v:scores.sleep}, {key:"nutrition", v:scores.nutrition},
      {key:"supplements", v:scores.supplements}, {key:"medical", v:scores.medical}
    ];
    var ranked = cats.slice().sort(function(a,b){
      var av = a.v===null ? 40 : a.v, bv = b.v===null ? 40 : b.v;
      return av-bv;
    });
    var picked = [];
    ranked.slice(0,2).forEach(function(c){
      var tier = tierFor(c.v);
      var t = TIPS_LIBRARY[c.key][tier][0];
      picked.push({label:CAT_NAME[c.key], text:t});
    });
    if(scores.openFlags>0){
      picked.unshift({label:"Médico", text:"Tienes " + scores.openFlags + " informe(s) marcado(s) como pendiente de seguimiento."});
    }
    var dayIdx = Math.floor(Date.now()/86400000) % TIP_BANK.length;
    picked.push({label:"Hoy", text: TIP_BANK[dayIdx]});

    var list = document.getElementById("tipsList");
    list.innerHTML = "";
    picked.slice(0,4).forEach(function(p){
      var li = document.createElement("li");
      li.innerHTML = '<span class="mark">'+p.label.toUpperCase()+'</span><span>'+p.text+'</span>';
      list.appendChild(li);
    });
  }

  function renderMejoras(scores){
    var cats = [
      {key:"sleep", v:scores.sleep, badge:"SUE"},
      {key:"nutrition", v:scores.nutrition, badge:"NUT"},
      {key:"supplements", v:scores.supplements, badge:"SUP"},
      {key:"medical", v:scores.medical, badge:"MED"}
    ];
    var wrap = document.getElementById("mejorasCats");
    wrap.innerHTML = "";
    cats.forEach(function(c){
      var tone = scoreTone(c.v);
      var tier = tierFor(c.v);
      var tips = TIPS_LIBRARY[c.key][tier];
      var el = document.createElement("div");
      el.className = "card mejora-card";
      el.innerHTML =
        '<div class="head"><span class="name"><span class="badge">'+c.badge+'</span>&nbsp;'+CAT_NAME[c.key]+'</span>' +
        '<span style="display:flex; align-items:center; gap:8px;"><span class="num" style="font-weight:600;">'+(c.v===null?"--":c.v)+'</span><span class="tag '+tone.cls+'">'+tone.label+'</span></span></div>' +
        '<ul class="tips-list">' + tips.map(function(t){ return '<li><span class="mark">—</span><span>'+t+'</span></li>'; }).join("") + '</ul>';
      wrap.appendChild(el);
    });
  }

  // ---------- personalized advice via sample (solo dentro de Claude) ----------
  var sampleFn = null;
  (async function initSample(){
    try{ sampleFn = await claude.use("sample"); }catch(e){ sampleFn = null; }
    if(!sampleFn){ document.getElementById("adviceBtn").style.display = "none"; }
  })();

  document.getElementById("adviceBtn").addEventListener("click", async function(){
    if(!sampleFn) return;
    var btn = this;
    var box = document.getElementById("adviceBox");
    var status = document.getElementById("adviceStatus");
    btn.disabled = true;
    status.style.display = "inline-flex";
    status.className = "tag warn";
    status.textContent = "Pensando...";
    box.textContent = "";

    var scores = computeScores(7);
    var recentMeals = state.meals.slice(0,5).map(function(m){ return "- "+m.date+" "+(m.mealType||"")+": "+(m.description||"").slice(0,120); }).join("\n") || "Sin registros.";
    var recentSleep = state.sleep.slice(0,5).map(function(s){ return "- "+s.date+": "+s.hours+"h, calidad "+s.quality+"/5"; }).join("\n") || "Sin registros.";
    var recentSup = state.supplements.slice(0,5).map(function(s){ return "- "+s.date+": "+s.name+" "+(s.dose||""); }).join("\n") || "Sin registros.";
    var recentMed = state.medical.slice(0,5).map(function(m){ return "- "+m.date+" ("+m.type+"): "+(m.title||"")+(m.flag?" [pendiente de seguimiento]":""); }).join("\n") || "Sin registros.";

    var prompt = "Eres un asistente de bienestar cercano y motivador (no eres médico ni das diagnósticos). " +
      "Con estos datos personales de los últimos días de un usuario, escribe un consejo personalizado en español, " +
      "cálido pero directo, de 120 a 180 palabras, con 2-3 acciones concretas y una frase final motivadora. " +
      "No uses viñetas, escribe en prosa fluida.\n\n" +
      "Scores actuales (0-100): sueño="+scores.sleep+", nutrición="+scores.nutrition+", suplementos="+scores.supplements+", médico="+scores.medical+", general="+scores.overall+".\n\n" +
      "Comidas recientes:\n"+recentMeals+"\n\nSueño reciente:\n"+recentSleep+"\n\nSuplementos recientes:\n"+recentSup+"\n\nInformes médicos recientes:\n"+recentMed;

    try{
      var result = await sampleFn(prompt, {
        modelTier: "default",
        cache: false,
        onText: function(u){ box.textContent = u.text; }
      });
      status.style.display = "none";
      if(result.truncated) showToast("Respuesta larga, se acortó un poco");
    }catch(e){
      status.className = "tag bad";
      if(e.code === "not_granted"){
        status.textContent = "Sin permiso para usar IA aquí";
        document.getElementById("adviceBtn").style.display = "none";
      } else if(e.code === "rate_limited"){
        status.textContent = "Demasiadas peticiones, prueba en un rato";
      } else if(e.code === "cancelled"){
        status.style.display = "none";
      } else {
        status.textContent = "No se pudo generar el consejo";
      }
      if(e.text) box.textContent = e.text;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- charts ----------
  function lastNDates(n){
    var arr = [];
    for(var i=n-1;i>=0;i--) arr.push(daysAgo(i));
    return arr;
  }

  function hexA(hex, alpha){
    hex = hex.trim();
    if(hex[0] !== "#") return hex;
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return "rgba("+r+","+g+","+b+","+alpha+")";
  }

  function renderCharts(){
    if(typeof Chart === "undefined") return;
    var dates = lastNDates(14);
    var ink = css("--ink"), inkSoft = css("--ink-soft"), line = css("--line");
    Chart.defaults.color = inkSoft;
    Chart.defaults.font.family = "IBM Plex Mono, monospace";
    Chart.defaults.borderColor = line;

    var sleepByDate = {};
    state.sleep.forEach(function(s){ sleepByDate[s.date] = s; });
    var hoursData = dates.map(function(d){ return sleepByDate[d] ? Number(sleepByDate[d].hours) : null; });
    var qualData = dates.map(function(d){ return sleepByDate[d] ? Number(sleepByDate[d].quality) : null; });

    if(charts.sleep) charts.sleep.destroy();
    charts.sleep = new Chart(document.getElementById("chartSleep"), {
      type:"line",
      data:{
        labels: dates.map(fmtDate),
        datasets:[
          {label:"Horas", data:hoursData, borderColor:ink, backgroundColor:hexA(ink,0.08), fill:true, tension:.3, spanGaps:true, yAxisID:"y"},
          {label:"Calidad (/5)", data:qualData, borderColor:inkSoft, tension:.3, spanGaps:true, yAxisID:"y1", borderDash:[4,3]}
        ]
      },
      options:{
        responsive:true,
        interaction:{mode:"index", intersect:false},
        scales:{
          y:{beginAtZero:true, suggestedMax:10, title:{display:true, text:"Horas"}},
          y1:{beginAtZero:true, max:5, position:"right", grid:{drawOnChartArea:false}, title:{display:true,text:"Calidad"}}
        }
      }
    });

    var mealsByDate = {};
    state.meals.forEach(function(m){
      var d = m.date;
      if(!mealsByDate[d]) mealsByDate[d] = [];
      mealsByDate[d].push(Number(m.quality)||3);
    });
    var mealAvg = dates.map(function(d){
      var arr = mealsByDate[d];
      if(!arr || !arr.length) return null;
      return +(arr.reduce(function(a,b){return a+b;},0)/arr.length).toFixed(2);
    });

    if(charts.meals) charts.meals.destroy();
    charts.meals = new Chart(document.getElementById("chartMeals"), {
      type:"bar",
      data:{ labels:dates.map(fmtDate), datasets:[{label:"Calidad media", data:mealAvg, backgroundColor:ink, borderRadius:2}] },
      options:{ responsive:true, scales:{ y:{beginAtZero:true, max:5} } }
    });

    var scores = computeScores(7);
    if(charts.radar) charts.radar.destroy();
    charts.radar = new Chart(document.getElementById("chartRadar"), {
      type:"radar",
      data:{
        labels:["Sueño","Nutrición","Suplementos","Médico"],
        datasets:[{
          label:"Score actual",
          data:[scores.sleep||0, scores.nutrition||0, scores.supplements||0, scores.medical||0],
          backgroundColor: hexA(ink, 0.14),
          borderColor: ink,
          pointBackgroundColor: ink
        }]
      },
      options:{
        responsive:true,
        scales:{ r:{ min:0, max:100, ticks:{stepSize:25, backdropColor:"transparent"}, grid:{color:line}, angleLines:{color:line} } },
        plugins:{legend:{display:false}}
      }
    });

    var heat = document.getElementById("heatGrid");
    heat.innerHTML = "";
    var days28 = lastNDates(28);
    var supByDate = {};
    state.supplements.forEach(function(s){ supByDate[s.date] = (supByDate[s.date]||0)+1; });
    days28.forEach(function(d){
      var c = supByDate[d]||0;
      var cell = document.createElement("div");
      cell.className = "heat-cell";
      cell.title = d + ": " + c + " registro(s)";
      cell.style.background = c===0 ? css("--fill-weak") : c===1 ? css("--fill-mid") : css("--fill-strong");
      heat.appendChild(cell);
    });
  }

  // ---------- history ----------
  var currentFilter = "all";
  document.getElementById("histFilters").addEventListener("click", function(e){
    var btn = e.target.closest("button[data-filter]");
    if(!btn) return;
    currentFilter = btn.dataset.filter;
    document.querySelectorAll("#histFilters button").forEach(function(b){ b.setAttribute("aria-pressed", b===btn); });
    renderHistory();
  });

  function typeMeta(type, entry){
    switch(type){
      case "meals": return {badge:"NUT", title:(entry.mealType||"Comida"), desc:entry.description};
      case "sleep": return {badge:"SUE", title:entry.hours+"h · calidad "+entry.quality+"/5", desc:entry.notes};
      case "supplements": return {badge:"SUP", title:entry.name+(entry.dose?" · "+entry.dose:""), desc:entry.notes};
      case "medical": return {badge:"MED", title:(entry.title||entry.type)+(entry.flag?" · pendiente":""), desc:entry.notes};
    }
  }

  function renderHistory(){
    var items = [];
    TYPES.forEach(function(type){
      if(currentFilter!=="all" && currentFilter!==type) return;
      state[type].forEach(function(e){ items.push({type:type, entry:e}); });
    });
    items.sort(function(a,b){ return (b.entry.date||"").localeCompare(a.entry.date||""); });

    var list = document.getElementById("historyList");
    list.innerHTML = "";
    if(!items.length){
      list.innerHTML = '<div class="empty">Aún no hay registros' + (currentFilter!=="all" ? " en esta categoría" : "") + '. Ve a "Registrar" para añadir el primero.</div>';
      return;
    }
    items.forEach(function(it){
      var meta = typeMeta(it.type, it.entry);
      var el = document.createElement("div");
      el.className = "hist-item";
      el.innerHTML =
        '<div class="badge">'+meta.badge+'</div>' +
        '<div class="content">' +
          '<div class="meta"><span>'+fmtDate(it.entry.date)+'</span>'+(it.entry.time?'<span>'+it.entry.time+'</span>':'')+'</div>' +
          '<div class="title">'+escapeHtml(meta.title||"")+'</div>' +
          (meta.desc ? '<div class="desc">'+escapeHtml(meta.desc)+'</div>' : '') +
        '</div>' +
        '<div class="actions"></div>';
      var actions = el.querySelector(".actions");
      if(it.type==="medical" && it.entry.flag){
        var rBtn = document.createElement("button");
        rBtn.className = "btn small ghost";
        rBtn.textContent = "Resolver";
        rBtn.addEventListener("click", function(){ resolveMedical(it.entry.id); });
        actions.appendChild(rBtn);
      }
      var dBtn = document.createElement("button");
      dBtn.className = "btn small danger";
      dBtn.textContent = "Borrar";
      dBtn.addEventListener("click", function(){
        if(confirm("¿Borrar este registro?")) deleteEntry(it.type, it.entry.id);
      });
      actions.appendChild(dBtn);
      list.appendChild(el);
    });
  }

  function escapeHtml(s){
    return String(s||"").replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
    });
  }

  // ---------- main render ----------
  function renderAll(){
    var scores = computeScores(7);
    renderGauge(scores);
    renderCatTiles(scores);
    renderBanner(scores);
    renderTips(scores);
    renderMejoras(scores);
    renderHistory();
    if(document.getElementById("view-stats").classList.contains("active")) renderCharts();
  }

  document.getElementById("todayLabel").textContent = new Date().toLocaleDateString("es-ES", {weekday:"long", day:"numeric", month:"long"});

  initStore();
})();
