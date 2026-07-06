import fs from 'fs';
const bytes = fs.readFileSync('./fw.wasm');
const mod = await WebAssembly.compile(bytes);
const imps = WebAssembly.Module.imports(mod).filter(i=>i.kind==='function').map(i=>i.name);
// filter to firmware symbols (drop emscripten runtime imports)
const fw = imps.filter(n=>/^(HAL_|LL_|USBD|MX_|f_|disk_|SystemClock|Error_Handler|NVIC_|__|CDC_|MSC_)/.test(n));
const rt = imps.filter(n=>!fw.includes(n));
console.log('total wasm function imports:', imps.length);
console.log('  firmware/HAL stubs needed:', fw.length);
console.log('  emscripten runtime:', rt.length);
const cat = {};
for(const n of fw){ const k=n.replace(/^(HAL_[A-Za-z]+|LL_[A-Za-z]+|USBD|MX|f_|disk_|CDC|MSC).*/, '$1'); cat[k]=(cat[k]||0)+1; }
console.log('  by prefix:', JSON.stringify(cat));
console.log('  === full firmware stub list ==='); console.log(fw.sort().join('\n'));
