/**
 * Lightweight session identity -- NOT authentication. Nothing is locked
 * behind this; it doesn't restrict access to any data. It exists purely so
 * "Counting as" / "Ordered by" / "Received by" fields across the app can
 * auto-fill with whoever's actually using this browser right now, instead
 * of retyping a name for every single action.
 *
 * Stored in localStorage with a timestamp; treated as expired after 8
 * hours, at which point the next page load (or call to Identity.prompt)
 * asks again. Always editable wherever it's pre-filled -- this is a
 * convenience default, not a lock.
 */
var Identity = (function(){
  var STORAGE_KEY = 'lottolot_identity';
  var TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

  function read(){
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return null;
      var parsed = JSON.parse(raw);
      if(!parsed || !parsed.name || !parsed.ts) return null;
      if(Date.now() - parsed.ts > TTL_MS){
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return parsed.name;
    } catch(e){
      return null;
    }
  }

  function write(name){
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: name, ts: Date.now() }));
    } catch(e){ /* private browsing / storage disabled -- the prompt still works, it just asks again next load */ }
  }

  function get(){
    return read();
  }

  // If a valid name is already stored, calls back immediately with it.
  // Otherwise shows a small modal asking for one; storing it and calling
  // back once submitted. "Skip for now" calls back with '' and asks again
  // next page load, since nothing here is required to use the app.
  function prompt(callback){
    var existing = read();
    if(existing){ callback(existing); return; }

    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,42,71,.55);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;font-family:Inter,Arial,sans-serif;';

    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:10px;max-width:360px;width:100%;padding:22px;box-shadow:0 10px 40px rgba(0,0,0,.25);';

    var title = document.createElement('div');
    title.textContent = "Who's working today?";
    title.style.cssText = 'font-size:16px;font-weight:700;color:#0f2a47;margin-bottom:6px;';

    var sub = document.createElement('div');
    sub.textContent = "Just so counts and orders show who did them -- not a login, you can change it anytime.";
    sub.style.cssText = 'font-size:12.5px;color:#5f7385;margin-bottom:14px;';

    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Your name';
    input.style.cssText = 'width:100%;padding:10px 12px;border:1px solid #dbe2e8;border-radius:6px;font-size:14px;font-family:inherit;box-sizing:border-box;margin-bottom:12px;';

    var btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:space-between;';

    var skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.textContent = 'Skip for now';
    skipBtn.style.cssText = 'background:none;border:none;color:#5f7385;font-size:12.5px;cursor:pointer;padding:8px 4px;';

    var continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.textContent = 'Continue';
    continueBtn.style.cssText = 'background:#0f2a47;color:#fff;border:none;border-radius:6px;padding:10px 20px;font-size:13.5px;font-weight:600;cursor:pointer;';

    function submit(){
      var name = input.value.trim();
      if(name) write(name);
      document.body.removeChild(overlay);
      callback(name);
    }

    continueBtn.addEventListener('click', submit);
    input.addEventListener('keydown', function(e){ if(e.key === 'Enter') submit(); });
    skipBtn.addEventListener('click', function(){
      document.body.removeChild(overlay);
      callback('');
    });

    btnRow.appendChild(skipBtn);
    btnRow.appendChild(continueBtn);
    box.appendChild(title);
    box.appendChild(sub);
    box.appendChild(input);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
  }

  return { get: get, prompt: prompt, write: write };
})();
