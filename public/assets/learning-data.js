// Lesson bodies are delivered only by the authenticated, subscription-filtered API.
window.ORBITA_LESSONS_READY=(async()=>{const r=await fetch('/api/lessons',{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(OrbitaAccess.supportMessage(data,'Не удалось загрузить обучение.'));window.ORBITA_LESSONS=data.lessons;})();
