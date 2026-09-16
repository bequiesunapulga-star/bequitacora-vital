(function(){
  "use strict";

  var TYPES = ["meals","sleep","supplements","medical","cycles"];
  var CAT_NAME = {sleep:"Sueño", nutrition:"Nutrición", supplements:"Suplementos", medical:"Médico"};

  var state = {meals:[], sleep:[], supplements:[], medical:[], cycles:[]};
  var db = null;
  var charts = {};

  // Local-calendar-date helper. Deliberately avoids toISOString() (UTC) so
  // date math stays consistent with local Date parsing/arithmetic elsewhere —
  // mixing the two silently shifts dates by a day in positive-UTC-offset zones.
  function toISO(d){
    var y = d.getFullYear(), m = d.getMonth()+1, day = d.getDate();
    return y + "-" + (m<10?"0":"")+m + "-" + (day<10?"0":"")+day;
  }
  function todayISO(){ return toISO(new Date()); }
  function fmtDate(iso){
    if(!iso) return "";
    var d = new Date(iso + "T00:00:00");
    if(isNaN(d)) return iso;
    return d.toLocaleDateString("es-ES", {day:"numeric", month:"short"});
  }
  function daysAgo(n){
    var d = new Date();
    d.setDate(d.getDate()-n);
    return toISO(d);
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
  document.getElementById("cicloGoRegistrar").addEventListener("click", function(){
    switchTab("registrar");
    document.querySelector('.subtabs button[data-form="cycle"]').click();
  });

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

  // ---------- cycle settings (localStorage-only, not per-entry) ----------
  var CYCLE_SETTINGS_KEY = "bequitacora_vital_cycle_settings";
  function getCycleSettings(){
    try{
      var raw = localStorage.getItem(CYCLE_SETTINGS_KEY);
      if(raw) return Object.assign({avgCycleLength:28, avgPeriodLength:5}, JSON.parse(raw));
    }catch(e){}
    return {avgCycleLength:28, avgPeriodLength:5};
  }
  function saveCycleSettings(s){
    try{ localStorage.setItem(CYCLE_SETTINGS_KEY, JSON.stringify(s)); }catch(e){}
  }
  (function initCycleSettingsForm(){
    var s = getCycleSettings();
    document.getElementById("settingCycleLength").value = s.avgCycleLength;
    document.getElementById("settingPeriodLength").value = s.avgPeriodLength;
  })();
  document.getElementById("form-cycle-settings").addEventListener("submit", function(e){
    e.preventDefault();
    var cycleLength = Number(document.getElementById("settingCycleLength").value) || 28;
    var periodLength = Number(document.getElementById("settingPeriodLength").value) || 5;
    saveCycleSettings({avgCycleLength:cycleLength, avgPeriodLength:periodLength});
    showToast("Ajustes guardados");
    renderAll();
  });

  // ---------- cycle phase model ----------
  function iconBlob(colorVar, o){
    var eyes = o.eyes==="closed"
      ? '<path d="M22,29 q3,-4 6,0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M36,29 q3,-4 6,0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
      : '<circle cx="25" cy="29" r="2.1" fill="currentColor"/><circle cx="39" cy="29" r="2.1" fill="currentColor"/>';
    var mouth;
    if(o.mouth==="sleepy") mouth = '<path d="M27,40 q5,2 10,0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    else if(o.mouth==="smile") mouth = '<path d="M25,39 q7,7 14,0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    else if(o.mouth==="bigsmile") mouth = '<path d="M23,38 q9,10 18,0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>';
    else mouth = '<path d="M26,40 q6,3 12,0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

    var motif = "";
    if(o.motif==="drop") motif = '<path d="M32,2 C34,7 37,10 37,13 C37,16.3 34.8,18 32,18 C29.2,18 27,16.3 27,13 C27,10 30,7 32,2 Z" fill="currentColor"/>';
    else if(o.motif==="sprout") motif = '<path d="M32,14 C32,8 28,6 24,6 C24,11 27,14 32,14 Z" fill="currentColor"/><path d="M32,14 C32,7 37,4 42,5 C41,10 37,14 32,14 Z" fill="currentColor"/><line x1="32" y1="14" x2="32" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    else if(o.motif==="star") motif = '<path d="M33,1 L34.4,6.2 L39,6.6 L35.3,9.8 L36.4,15 L33,11.9 L29.6,15 L30.7,9.8 L27,6.6 L31.6,6.2 Z" fill="currentColor"/>';
    else if(o.motif==="moon") motif = '<path d="M38,3 C31,4 27,10 27,15 C27,21 32,26 38,26 C33.5,23.5 31,19.3 31,15 C31,10.7 33.5,6.5 38,3 Z" fill="currentColor"/>';

    return '<svg viewBox="0 0 64 46" width="56" height="42" aria-hidden="true">' +
      '<g style="color:var(--ink)">' + motif + '</g>' +
      '<path d="M32,14 C46,12 58,22 58,32 C58,42 46,44 32,44 C18,44 6,42 6,32 C6,21 18,16 32,14 Z" fill="var(' + colorVar + ')" stroke="var(--ink)" stroke-width="1.6"/>' +
      '<g style="color:var(--ink)">' + eyes + mouth + '</g>' +
    '</svg>';
  }

  var CYCLE_PHASES = {
    menstrual: {
      name:"Fase Sangre", short:"Menstrual", colorVar:"--phase-menstrual",
      desc:"Los niveles hormonales están en su punto más bajo. El cuerpo suele pedir descanso, calor y calma.",
      edu:"El revestimiento del útero se desprende: es tu periodo. Estrógeno y progesterona están en su punto más bajo del ciclo. Es común notar menos energía, molestias abdominales o mayor sensibilidad — y también es normal no notar apenas nada.",
      tcm:"En la MTC se asocia al descenso del Yin y la sangre. Tradicionalmente se recomienda mantener el cuerpo caliente (evitar bebidas frías), descansar más de lo habitual y tomar caldos, jengibre o remolacha.",
      icon: null
    },
    folicular: {
      name:"Fase Renacer", short:"Folicular", colorVar:"--phase-folicular",
      desc:"El estrógeno empieza a subir. La energía y el ánimo suelen ir en aumento.",
      edu:"El cuerpo empieza a preparar un nuevo óvulo mientras el estrógeno sube progresivamente. Suele notarse un aumento gradual de energía, mejor ánimo y más claridad mental a medida que avanza la fase.",
      tcm:"El Yin comienza a reconstruirse. Tradicionalmente es buen momento para retomar movimiento suave y alimentos frescos y ligeros como verduras de hoja verde.",
      icon: null
    },
    ovulatoria: {
      name:"Fase Cénit", short:"Ovulatoria", colorVar:"--phase-ovulatoria",
      desc:"Pico de energía y de fertilidad. Suele ser el momento de mayor vitalidad del ciclo.",
      edu:"Se libera un óvulo. Es el pico de estrógeno y de la hormona LH, y la ventana de mayor fertilidad del ciclo. Muchas personas notan aquí su mayor pico de energía, libido y confianza — aunque es una ventana corta, de solo un par de días.",
      tcm:"Se considera el máximo de Yang y Qi. Tradicionalmente, el momento de mayor vitalidad para socializar y para el ejercicio más intenso.",
      icon: null
    },
    lutea: {
      name:"Fase Recogimiento", short:"Lútea", colorVar:"--phase-lutea",
      desc:"La progesterona domina. Es común notar más introspección o sensibilidad antes del periodo.",
      edu:"El cuerpo se prepara para un posible embarazo: sube la progesterona y, si no lo hay, cae de nuevo hacia el final. Es la fase más larga del ciclo. Hacia el final es habitual el síndrome premenstrual: cansancio, cambios de apetito o de humor.",
      tcm:"El Yang desciende hacia el Yin. Tradicionalmente se recomienda moderar el ritmo, cuidar el sueño y priorizar alimentos nutritivos y fáciles de digerir.",
      icon: null
    }
  };
  CYCLE_PHASES.menstrual.icon = iconBlob("--phase-menstrual", {eyes:"closed", mouth:"sleepy", motif:"drop"});
  CYCLE_PHASES.folicular.icon = iconBlob("--phase-folicular", {eyes:"open", mouth:"smile", motif:"sprout"});
  CYCLE_PHASES.ovulatoria.icon = iconBlob("--phase-ovulatoria", {eyes:"open", mouth:"bigsmile", motif:"star"});
  CYCLE_PHASES.lutea.icon = iconBlob("--phase-lutea", {eyes:"open", mouth:"soft", motif:"moon"});

  function getPhaseBoundaries(avgCycleLength, avgPeriodLength){
    var periodLength = avgPeriodLength;
    var ovulationDay = Math.max(periodLength+2, avgCycleLength-14);
    var ovStart = Math.max(periodLength+1, ovulationDay-1);
    var ovEnd = Math.min(avgCycleLength, ovulationDay+1);
    var folStart = periodLength+1;
    var folEnd = Math.max(folStart, ovStart-1);
    var lutStart = Math.min(ovEnd+1, avgCycleLength);
    return {
      menstrual:{start:1, end:periodLength},
      folicular:{start:folStart, end:folEnd},
      ovulatoria:{start:ovStart, end:ovEnd},
      lutea:{start:lutStart, end:avgCycleLength},
      ovulationDay: ovulationDay
    };
  }
  function phaseForDay(day, b){
    if(day<=b.menstrual.end) return "menstrual";
    if(day<=b.folicular.end) return "folicular";
    if(day<=b.ovulatoria.end) return "ovulatoria";
    return "lutea";
  }

  function computeCycleStatus(){
    var settings = getCycleSettings();
    if(!state.cycles.length) return {hasData:false, settings:settings};
    var entries = state.cycles.slice().sort(function(a,b){ return (a.date||"").localeCompare(b.date||""); });
    var last = entries[entries.length-1];
    var lastStart = new Date(last.date+"T00:00:00");
    var today = new Date(todayISO()+"T00:00:00");
    var cycleDay = Math.round((today-lastStart)/86400000)+1;
    var b = getPhaseBoundaries(settings.avgCycleLength, settings.avgPeriodLength);
    var clampedDay = Math.min(Math.max(cycleDay,1), settings.avgCycleLength);
    var phaseKey = phaseForDay(clampedDay, b);

    var nextPeriod = new Date(lastStart); nextPeriod.setDate(nextPeriod.getDate()+settings.avgCycleLength);
    var ovulation = new Date(lastStart); ovulation.setDate(ovulation.getDate()+b.ovulationDay-1);
    var fertileStart = new Date(ovulation); fertileStart.setDate(fertileStart.getDate()-5);
    var fertileEnd = new Date(ovulation); fertileEnd.setDate(fertileEnd.getDate()+1);

    var lengths = [];
    for(var i=1;i<entries.length;i++){
      var d0 = new Date(entries[i-1].date+"T00:00:00"), d1 = new Date(entries[i].date+"T00:00:00");
      lengths.push({date:entries[i].date, length:Math.round((d1-d0)/86400000)});
    }

    return {
      hasData:true, settings:settings, boundaries:b, lastStart:last.date,
      cycleDay:cycleDay, displayDay:clampedDay, overdue: cycleDay>settings.avgCycleLength,
      phaseKey:phaseKey,
      nextPeriod: toISO(nextPeriod),
      ovulation: toISO(ovulation),
      fertileStart: toISO(fertileStart),
      fertileEnd: toISO(fertileEnd),
      lengths: lengths
    };
  }

  function renderCiclo(){
    var status = computeCycleStatus();
    var empty = document.getElementById("cicloEmpty");
    var content = document.getElementById("cicloContent");

    renderPhaseEducation(status.settings || getCycleSettings());

    if(!status.hasData){
      empty.style.display = "block";
      content.style.display = "none";
      return;
    }
    empty.style.display = "none";
    content.style.display = "block";

    var phase = CYCLE_PHASES[status.phaseKey];
    document.getElementById("phaseMascot").innerHTML = phase.icon;
    document.getElementById("phaseName").textContent = phase.name;
    document.getElementById("phaseDesc").textContent = phase.desc + (status.overdue ? " Tu periodo previsto ya ha pasado — si no ha llegado, actualiza el registro cuando empiece." : "");
    document.getElementById("cicloDates").innerHTML =
      '<div><strong>Día ' + status.displayDay + '</strong> de ' + status.settings.avgCycleLength + ' · fase ' + phase.short + '</div>' +
      '<div>Próximo periodo previsto: <strong>' + fmtDate(status.nextPeriod) + '</strong></div>' +
      '<div>Ventana fértil estimada: <strong>' + fmtDate(status.fertileStart) + ' – ' + fmtDate(status.fertileEnd) + '</strong></div>';

    var b = status.boundaries, len = status.settings.avgCycleLength;
    var mEnd = (b.menstrual.end/len*100).toFixed(2);
    var fEnd = (b.folicular.end/len*100).toFixed(2);
    var oEnd = (b.ovulatoria.end/len*100).toFixed(2);
    document.getElementById("wheelRing").style.background =
      'conic-gradient(from -90deg, var(--phase-menstrual) 0% ' + mEnd + '%, var(--phase-folicular) ' + mEnd + '% ' + fEnd + '%, ' +
      'var(--phase-ovulatoria) ' + fEnd + '% ' + oEnd + '%, var(--phase-lutea) ' + oEnd + '% 100%)';
    var angle = (status.displayDay-1)/len*360 - 90;
    document.getElementById("wheelMarker").style.transform = 'rotate(' + angle.toFixed(1) + 'deg) translate(0, -78px)';
    document.getElementById("wheelCenter").innerHTML =
      '<div class="day-num num">' + status.displayDay + '</div><div class="day-label">' + phase.short + '</div>';
  }

  function renderPhaseEducation(settings){
    var b = getPhaseBoundaries(settings.avgCycleLength, settings.avgPeriodLength);
    var order = ["menstrual","folicular","ovulatoria","lutea"];
    var list = document.getElementById("phaseEduList");
    list.innerHTML = order.map(function(key){
      var phase = CYCLE_PHASES[key];
      var range = b[key];
      var rangeLabel = range.start===range.end ? ("Día " + range.start) : ("Días " + range.start + "–" + range.end);
      return '<div class="phase-edu-item">' +
        '<div class="mascot">' + phase.icon + '</div>' +
        '<div class="body">' +
          '<div class="head"><h3>' + phase.name + '</h3><span class="range">' + rangeLabel + ' · ' + phase.short.toUpperCase() + '</span></div>' +
          '<p>' + phase.edu + '</p>' +
        '</div>' +
      '</div>';
    }).join("");
  }

  function renderMTC(){
    var status = computeCycleStatus();
    var mtcPhaseEl = document.getElementById("mtcPhase");

    var season = getSeason(new Date());
    document.getElementById("mtcSeason").innerHTML =
      '<div class="mtc-title">La estación: ' + season.name + '<span class="tag none">' + season.element + ' / ' + season.organ + '</span></div>' + season.mtcNote;

    if(!status.hasData){
      mtcPhaseEl.style.display = "none";
      return;
    }
    mtcPhaseEl.style.display = "block";
    var phase = CYCLE_PHASES[status.phaseKey];
    mtcPhaseEl.innerHTML =
      '<div class="mtc-title">Tu fase: ' + phase.name + '<span class="tag warn">' + phase.short + '</span></div>' + phase.tcm;
  }

  // ---------- season + moon (nota del día) ----------
  function getSeason(date){
    var m = date.getMonth();
    if(m===11||m===0||m===1) return {name:"Invierno", element:"Agua", organ:"Riñones",
      note:"Tiempo de recogimiento. Muchas tradiciones invitan a conservar energía, dormir más y cuidar el calor del cuerpo.",
      mtcNote:"La MTC asocia el invierno con el elemento Agua y los riñones. Tradicionalmente se recomienda descansar más, abrigar la zona lumbar y priorizar alimentos calientes y nutritivos."};
    if(m>=2&&m<=4) return {name:"Primavera", element:"Madera", organ:"Hígado",
      note:"Tiempo de expansión. Se suele asociar esta estación con nuevos comienzos y con soltar la rigidez del invierno.",
      mtcNote:"La MTC asocia la primavera con el elemento Madera y el hígado. Tradicionalmente es buen momento para moverse más, comer ligero y dejar espacio a proyectos nuevos."};
    if(m>=5&&m<=7) return {name:"Verano", element:"Fuego", organ:"Corazón",
      note:"Tiempo de máxima actividad. La tradición invita a socializar y disfrutar, sin descuidar la hidratación y el descanso.",
      mtcNote:"La MTC asocia el verano con el elemento Fuego y el corazón. Tradicionalmente se recomienda mantenerse fresco, hidratado y cuidar el descanso nocturno pese a los días largos."};
    return {name:"Otoño", element:"Metal", organ:"Pulmón",
      note:"Tiempo de soltar y ordenar. Se suele asociar esta estación con la respiración consciente y con cerrar ciclos antes del invierno.",
      mtcNote:"La MTC asocia el otoño con el elemento Metal y el pulmón. Tradicionalmente es buen momento para la respiración consciente, ordenar espacios y soltar lo que ya no aporta."};
  }

  function getMoonPhase(date){
    var synodic = 29.530588853;
    var known = Date.UTC(2000,0,6,18,14,0);
    var days = (date.getTime()-known)/86400000;
    var phase = ((days % synodic)+synodic)%synodic / synodic;
    var table = [
      {max:0.03, name:"Luna nueva", note:"Tradicionalmente, un buen momento simbólico para sembrar intenciones nuevas."},
      {max:0.22, name:"Luna creciente", note:"Se suele asociar con dar los primeros pasos hacia lo que te propones."},
      {max:0.28, name:"Cuarto creciente", note:"Momento simbólico de ajuste según avanza lo iniciado."},
      {max:0.47, name:"Gibosa creciente", note:"Fase de refinar detalles antes de que algo llegue a su punto máximo."},
      {max:0.53, name:"Luna llena", note:"Tradicionalmente el punto de mayor intensidad emocional y de resultados visibles."},
      {max:0.72, name:"Gibosa menguante", note:"Buen momento simbólico para agradecer y compartir lo aprendido."},
      {max:0.78, name:"Cuarto menguante", note:"Fase de soltar lo que ya no aporta y hacer limpieza."},
      {max:0.97, name:"Luna menguante", note:"Momento de descanso y cierre antes de que el ciclo vuelva a empezar."},
      {max:1.01, name:"Luna nueva", note:"Tradicionalmente, un buen momento simbólico para sembrar intenciones nuevas."}
    ];
    var entry = table[0];
    for(var i=0;i<table.length;i++){ if(phase<=table[i].max){ entry = table[i]; break; } }
    return Object.assign({fraction:phase}, entry);
  }

  function moonIcon(phase){
    if(phase<0.03||phase>0.97){
      return '<svg viewBox="0 0 22 22" width="22" height="22"><circle cx="11" cy="11" r="8" fill="none" stroke="var(--ink)" stroke-width="1.6"/></svg>';
    }
    if(phase>=0.47&&phase<=0.53){
      return '<svg viewBox="0 0 22 22" width="22" height="22"><circle cx="11" cy="11" r="9" fill="var(--ink)"/></svg>';
    }
    var waxing = phase<0.5;
    var illum = waxing ? Math.min(phase/0.5,1) : Math.min((1-phase)/0.5,1);
    var offset = illum*18;
    var dir = waxing ? -1 : 1;
    var cx = 11 + dir*offset;
    return '<svg viewBox="0 0 22 22" width="22" height="22">' +
      '<circle cx="11" cy="11" r="9" fill="var(--ink)"/>' +
      '<circle cx="' + cx.toFixed(1) + '" cy="11" r="9" fill="var(--surface)"/>' +
    '</svg>';
  }

  function renderNotaDelDia(){
    var today = new Date();
    var season = getSeason(today);
    var moon = getMoonPhase(today);
    document.getElementById("notaDelDia").innerHTML =
      '<div class="nota-head">Nota del día</div>' +
      '<div class="nota-body">' +
        '<div class="nota-item"><span class="nota-icon">' + moonIcon(moon.fraction) + '</span><div><strong>' + moon.name + '</strong><br>' + moon.note + '</div></div>' +
        '<div class="nota-item"><span class="nota-icon serif" style="font-style:normal; font-size:1.1rem;">'+ season.element[0] +'</span><div><strong>' + season.name + '</strong> · ' + season.element + ' / ' + season.organ + '<br>' + season.note + '</div></div>' +
      '</div>';
  }

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

    var cycleCard = document.getElementById("cycleChartCard");
    var cycleStatus = computeCycleStatus();
    if(cycleStatus.hasData && cycleStatus.lengths.length){
      cycleCard.style.display = "block";
      var lastLengths = cycleStatus.lengths.slice(-8);
      if(charts.cycle) charts.cycle.destroy();
      charts.cycle = new Chart(document.getElementById("chartCycle"), {
        type:"bar",
        data:{
          labels: lastLengths.map(function(l){ return fmtDate(l.date); }),
          datasets:[{label:"Días", data: lastLengths.map(function(l){ return l.length; }), backgroundColor:ink, borderRadius:2}]
        },
        options:{ responsive:true, scales:{ y:{beginAtZero:true, suggestedMax:35} } }
      });
    } else {
      cycleCard.style.display = "none";
    }
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
      case "cycles": return {badge:"CIC", title:"Inicio de periodo", desc:""};
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
    renderCiclo();
    renderMTC();
    renderNotaDelDia();
    renderHistory();
    if(document.getElementById("view-stats").classList.contains("active")) renderCharts();
  }

  document.getElementById("todayLabel").textContent = new Date().toLocaleDateString("es-ES", {weekday:"long", day:"numeric", month:"long"});

  initStore();
})();
