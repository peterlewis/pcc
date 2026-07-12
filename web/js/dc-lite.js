// dc-lite.js — a tiny, dependency-free runtime that replaces the Claude-Design
// React/Babel authoring shell for PCC Web. It binds a STATIC {{…}}-templated DOM to a
// controller's `state` + `renderVals()`, replicating the exact DC contract the app body
// (app-controller.js) was written against, with zero framework and zero network fetches.
//
// Contract replicated (verified against the prototype + its support.js runtime):
//   • ref="{{refX}}"                → this.ref('x')(el): caches el into this.els.x  (X → lc first)
//   • onClick|onInput|onChange|…="{{handler}}"  → event listener calling the current renderVals value
//   • style|disabled|value|any-attr="{{name}}"  → set from renderVals each render
//   • text  …{{name}}…             → substituted each render
//   • <sc-if value="{{cond}}">…</sc-if>  → subtree shown/hidden by the boolean renderVals value
//
// Design: scan the DOM ONCE on mount to collect binding points; each render re-runs
// renderVals() and updates only those points. Handlers are late-bound (read renderVals at
// event time) so closures created in renderVals stay fresh without re-attaching listeners.

const EVT = {
  onclick: 'click', oninput: 'input', onchange: 'change', onsubmit: 'submit',
  onmouseenter: 'mouseenter', onmouseleave: 'mouseleave', onmousedown: 'mousedown',
  onmouseup: 'mouseup', onmousemove: 'mousemove', onkeydown: 'keydown', onkeyup: 'keyup',
  onfocus: 'focus', onblur: 'blur', onwheel: 'wheel', onpointerdown: 'pointerdown',
  onpointermove: 'pointermove', onpointerup: 'pointerup',
  onpointerleave: 'pointerleave', onpointercancel: 'pointercancel',
};
const PH = /\{\{\s*([^}]+?)\s*\}\}/g;          // {{ name }}
const lcFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

export class DcLite {
  constructor(props = {}) {
    this.props = props;
    this.state = {};
    this.els = {};
    this._binds = [];      // { el, attr, tmpl } or { text, tmpl }  (attr updated each render)
    this._ifs = [];        // { el, name } sc-if conditions
    this._fors = [];       // { anchor, listName, asVar, tmpl, sig } sc-for repeaters
    this._pending = false;
    this._cbs = [];
  }

  // ---- React-shaped API the app body calls -------------------------------------------
  setState(patch, cb) {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    Object.assign(this.state, next);
    if (cb) this._cbs.push(cb);
    if (!this._pending) {                 // coalesce to one microtask render
      this._pending = true;
      Promise.resolve().then(() => {
        this._pending = false;
        this.render();
        const cbs = this._cbs; this._cbs = [];
        for (const f of cbs) { try { f(); } catch (e) { console.error(e); } }
      });
    }
  }
  forceUpdate() { this.setState({}); }

  // stable per-name ref callback → caches the element into this.els (matches the prototype)
  ref(name) {
    (this._refs || (this._refs = {}));
    if (!this._refs[name]) {
      this._refs[name] = (el) => {
        if (el) { this.els[name] = el; if (this.ready) this.initEl && this.initEl(name, el); }
        else { delete this.els[name]; this.dropEl && this.dropEl(name); }
      };
    }
    return this._refs[name];
  }

  // ---- mount -------------------------------------------------------------------------
  async mount(root) {
    this.root = root;
    this._scan(root);                 // establishes refs (this.els populated) + collects binds
    this.render();                    // first paint of dynamic content
    if (this.componentDidMount) await this.componentDidMount();
  }

  // walk the tree once; wire refs + events immediately, record attr/text/if bindings
  _scan(node) {
    if (node.nodeType === 3) {        // text node
      if (node.nodeValue && node.nodeValue.includes('{{')) {
        this._binds.push({ text: node, tmpl: node.nodeValue });
      }
      return;
    }
    if (node.nodeType !== 1) return;

    const tag = node.tagName.toLowerCase();
    if (tag === 'sc-if') {
      const raw = node.getAttribute('value') || '';
      const m = PH.exec(raw); PH.lastIndex = 0;
      const name = m ? m[1].trim() : null;
      // replace <sc-if> with a plain wrapper that carries display:contents so layout is
      // unaffected when shown; toggled to display:none when the condition is false.
      const wrap = document.createElement('div');
      wrap.style.display = 'contents';
      while (node.firstChild) wrap.appendChild(node.firstChild);
      node.replaceWith(wrap);
      if (name) this._ifs.push({ el: wrap, name });
      this._scan(wrap);
      return;
    }

    if (tag === 'sc-for') {
      // <sc-for list="{{items}}" as="r">…{{r.field}}…</sc-for> → repeat the child template
      // once per list item, binding {{r.*}} against each item. Template children are captured
      // (not globally scanned) and cloned + per-item-bound at render time.
      const mL = PH.exec(node.getAttribute('list') || ''); PH.lastIndex = 0;
      const listName = mL ? mL[1].trim() : null;
      const asVar = node.getAttribute('as') || 'item';
      const tmpl = document.createElement('template');
      while (node.firstChild) tmpl.content.appendChild(node.firstChild);
      const anchor = document.createElement('div');
      anchor.style.display = 'contents';
      node.replaceWith(anchor);
      if (listName) this._fors.push({ anchor, listName, asVar, tmpl, sig: null });
      return;
    }

    // attributes: ref / on* / dynamic {{}} values
    const toRemove = [];
    for (const at of Array.from(node.attributes)) {
      const an = at.name.toLowerCase(), av = at.value;
      if (an === 'ref') {                                   // ref="{{refX}}"
        const m = PH.exec(av); PH.lastIndex = 0;
        if (m) {
          const key = lcFirst(m[1].trim().replace(/^ref/, ''));
          this.ref(key)(node);                              // cache el now (static DOM)
        }
        toRemove.push(at.name);
      } else if (EVT[an] && av.includes('{{')) {            // onClick="{{handler}}"
        const m = PH.exec(av); PH.lastIndex = 0;
        const key = m[1].trim();
        node.addEventListener(EVT[an], (e) => {
          const fn = this._rv && this._rv[key];
          if (typeof fn === 'function') return fn(e);
        });
        toRemove.push(at.name);
      } else if (an.startsWith('hint-placeholder')) {
        toRemove.push(at.name);                             // DC authoring hint — drop
      } else if (av.includes('{{')) {                       // dynamic attribute value
        this._binds.push({ el: node, attr: at.name, tmpl: av });
      }
    }
    for (const n of toRemove) node.removeAttribute(n);

    for (const c of Array.from(node.childNodes)) this._scan(c);
  }

  // ---- render ------------------------------------------------------------------------
  render() {
    const rv = this.renderVals ? this.renderVals() : {};
    this._rv = rv;

    for (const cond of this._ifs) {
      cond.el.style.display = rv[cond.name] ? 'contents' : 'none';
    }

    for (const b of this._binds) {
      if (b.text) {
        b.text.nodeValue = b.tmpl.replace(PH, (_, k) => fmt(rv[k.trim()]));
      } else {
        const v = (b.tmpl.trim().match(/^\{\{\s*([^}]+?)\s*\}\}$/))   // pure single placeholder?
          ? rv[b.tmpl.trim().slice(2, -2).trim()]
          : b.tmpl.replace(PH, (_, k) => fmt(rv[k.trim()]));
        applyAttr(b.el, b.attr, v);
      }
    }

    // sc-for repeaters: when the list signature changes, reconcile by key. A key is stable +
    // encodes the row's content (forKey), so a matching key means the existing row node can be
    // reused untouched; only genuinely-new rows are cloned + bound. This keeps a fast-scrolling
    // 240-line log to ~one clone per frame instead of rebuilding every row every render.
    for (const f of this._fors) {
      const arr = Array.isArray(rv[f.listName]) ? rv[f.listName] : [];
      const keys = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) keys[i] = forKey(arr[i]);
      const sig = arr.length + '§' + keys.join('¦');
      if (sig === f.sig) continue;
      f.sig = sig;
      const old = f._byKey || new Map();
      const next = new Map();
      const desired = [];
      for (let i = 0; i < arr.length; i++) {
        const key = keys[i];
        let el = old.get(key);
        if (!el || next.has(key)) {                 // new row (or duplicate key this pass)
          const clone = f.tmpl.content.cloneNode(true);
          this._bindForItem(clone, f.asVar, arr[i]);
          el = clone.firstElementChild;
          if (!el) continue;
        }
        next.set(key, el);
        desired.push(el);
      }
      f.anchor.textContent = '';
      for (const el of desired) f.anchor.appendChild(el);
      f._byKey = next;
    }
  }

  // bind {{asVar.*}} placeholders inside a freshly-cloned sc-for row against one item
  _bindForItem(frag, asVar, item) {
    const resolve = (key) => {
      key = key.trim();
      if (key === asVar) return item;
      if (key.startsWith(asVar + '.')) return item ? item[key.slice(asVar.length + 1)] : undefined;
      return this._rv ? this._rv[key] : undefined;   // fall back to outer scope
    };
    const walk = (node) => {
      if (node.nodeType === 3) {
        if (node.nodeValue && node.nodeValue.includes('{{')) node.nodeValue = node.nodeValue.replace(PH, (_, k) => fmt(resolve(k)));
        return;
      }
      if (node.nodeType !== 1) return;
      const toRemove = [];
      for (const at of Array.from(node.attributes)) {
        const an = at.name.toLowerCase(), av = at.value;
        if (an === 'ref') { toRemove.push(at.name); }
        else if (EVT[an] && av.includes('{{')) {
          const m = PH.exec(av); PH.lastIndex = 0;
          const fn = m ? resolve(m[1]) : null;
          if (typeof fn === 'function') node.addEventListener(EVT[an], fn);
          toRemove.push(at.name);
        } else if (an.startsWith('hint-placeholder')) { toRemove.push(at.name); }
        else if (av.includes('{{')) {
          const pure = av.trim().match(/^\{\{\s*([^}]+?)\s*\}\}$/);
          applyAttr(node, at.name, pure ? resolve(pure[1]) : av.replace(PH, (_, k) => fmt(resolve(k))));
        }
      }
      for (const n of toRemove) node.removeAttribute(n);
      for (const c of Array.from(node.childNodes)) walk(c);
    };
    for (const c of Array.from(frag.childNodes)) walk(c);
  }
}

// a cheap per-item signature so a repeater only rebuilds when its data actually changes
function forKey(it) {
  if (it == null) return '';
  if (typeof it !== 'object') return String(it);
  if (it.k != null) return String(it.k);
  if (it.key != null) return String(it.key);
  let s = '';
  for (const kk in it) { const v = it[kk]; if (typeof v !== 'function') s += kk + '=' + v + ';'; }
  return s;
}

// set an attribute/property the way the DOM expects (booleans, form values, style)
function applyAttr(el, attr, v) {
  if (attr === 'disabled' || attr === 'checked' || attr === 'hidden' || attr === 'selected') {
    if (v) el.setAttribute(attr, ''); else el.removeAttribute(attr);
    el[attr] = !!v;
    return;
  }
  if (attr === 'value' && ('value' in el)) { if (el.value !== v) el.value = v == null ? '' : v; return; }
  if (v == null || v === false) el.removeAttribute(attr);
  else el.setAttribute(attr, v === true ? '' : String(v));
}

function fmt(v) { return v == null || v === false ? '' : String(v); }
