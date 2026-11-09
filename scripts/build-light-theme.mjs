// Generates public/assets/theme-light.css from the dark stylesheets of the
// cabinet and admin. Every colour declaration is re-emitted under
// html[data-theme=light] with a mapped colour:
//  - neutral backgrounds: dark → near-white surfaces, light → dark (buttons);
//  - neutral foregrounds (text, borders, strokes): lightness inverted;
//  - accents (blue/gold/green/red): kept in hue, darkened for contrast on white;
//  - translucent white overlays become translucent ink.
// Re-run after changing any dark stylesheet:  node scripts/build-light-theme.mjs
import {readFile,writeFile,readdir,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../public/',import.meta.url));
const EXCLUDE=new Set(['landing.css','market-demo.css','theme-light.css','theme-light-fixes.css']);
const FG=/^(color|fill|stroke|border(-top|-right|-bottom|-left)?(-color)?|outline(-color)?|text-decoration(-color)?|caret-color|column-rule(-color)?|stop-color|accent-color|text-shadow)$/;
const BG=/^(background(-color|-image)?|box-shadow)$/;
const COLOR=/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

function parse(hex){
 if(hex.startsWith('rgb')){const v=hex.match(/[\d.]+%?/g).map(Number);return {r:v[0],g:v[1],b:v[2],a:v[3]??1};}
 let h=hex.slice(1);if(h.length===3||h.length===4)h=[...h].map(c=>c+c).join('');
 return {r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16),a:h.length===8?parseInt(h.slice(6,8),16)/255:1};
}
function toHsl({r,g,b}){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),l=(max+min)/2;let h=0,s=0;if(max!==min){const d=max-min;s=l>.5?d/(2-max-min):d/(max+min);h=max===r?(g-b)/d+(g<b?6:0):max===g?(b-r)/d+2:(r-g)/d+4;h/=6;}return {h,s,l,chroma:max-min};}
function fromHsl(h,s,l){if(!s){const v=Math.round(l*255);return [v,v,v];}const q=l<.5?l*(1+s):l+s-l*s,p=2*l-q,t=x=>{x=(x+1)%1;return x<1/6?p+(q-p)*6*x:x<1/2?q:x<2/3?p+(q-p)*(2/3-x)*6:p;};return [t(h+1/3),t(h),t(h-1/3)].map(v=>Math.round(v*255));}
const hex=([r,g,b],a)=>'#'+[r,g,b,...(a<1?[Math.round(a*255)]:[])].map(v=>Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join('');
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));

const lumOf=([r,g,b])=>{const f=x=>{x/=255;return x<=.03928?x/12.92:((x+.055)/1.055)**2.4;};return .2126*f(r)+.7152*f(g)+.0722*f(b);};
const contrast=(rgb,bg=[245,247,251])=>{const a=lumOf(rgb),b=lumOf(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
// Darken until the colour reads as text on the light page background (WCAG AA 4.5:1 + margin).
function readable(h,s,l,target=5.2){let rgb=fromHsl(h,s,l);while(contrast(rgb)<target&&l>.05){l-=.02;rgb=fromHsl(h,s,l);}return rgb;}
export function mapColor(value,role,text=false){
 const c=parse(value),{h,s,l,chroma}=toHsl(c);const accent=chroma>=.18;
 // Translucent overlays: white tints become ink tints, coloured tints keep hue.
 if(c.a<.6){
  if(!accent&&l>.6)return hex([18,26,40],clamp(c.a*1.25,0,1));
  if(!accent)return hex(fromHsl(h,s,clamp(1-l,0,1)),c.a*.6);
  return hex(fromHsl(h,clamp(s,0,1),clamp(Math.min(l,.45),0,1)),clamp(c.a*1.1,0,1));
 }
 if(role==='bg'){
  if(!accent)return hex(fromHsl(h,Math.min(s,.35),l<.5?clamp(.985-l*.22,.9,.99):clamp(1-l+.02,.08,.3)),c.a);
  return hex(fromHsl(h,clamp(s,0,1),l>.6?.4:clamp(l,.3,.42)),c.a);
 }
 // Dark text sat on light (pale) surfaces, which become dark: it turns white.
 if(!accent&&l<.3)return hex(fromHsl(h,Math.min(s,.2),clamp(1-l,.96,.99)),c.a);
 if(!accent){const L=clamp((1-l)*.92,.07,.6);return hex(text?readable(h,Math.min(s,.3),L):fromHsl(h,Math.min(s,.3),L),c.a);}
 const L=clamp(Math.min(l,.4),.22,.4);return hex(text?readable(h,clamp(s*1.05,0,1),L):fromHsl(h,clamp(s*1.05,0,1),L),c.a);
}

// Minimal CSS walker for minified/hand-written files: blocks, @media, @supports.
function* blocks(css,context=[]){
 let i=0;const n=css.length;
 while(i<n){
  if(css.startsWith('/*',i)){i=css.indexOf('*/',i+2);if(i<0)return;i+=2;continue;}
  if(/^\s/.test(css[i])){i++;continue;}
  // Statement at-rules (@import url(...a;b...);) end at a ';' outside parentheses/quotes.
  if(css.startsWith('@import',i)||css.startsWith('@charset',i)){let depth=0,q=null,j=i;for(;j<n;j++){const ch=css[j];if(q){if(ch===q)q=null;continue;}if(ch==='"'||ch==="'")q=ch;else if(ch==='(')depth++;else if(ch===')')depth--;else if(ch===';'&&!depth)break;}i=j+1;continue;}
  const open=css.indexOf('{',i),semi=css.indexOf(';',i);
  if(open<0)return;
  if(semi>=0&&semi<open&&css.slice(i,semi).trim().startsWith('@')){i=semi+1;continue;}
  const prelude=css.slice(i,open).trim();let depth=1,j=open+1;
  while(j<n&&depth){const ch=css[j];if(ch==='{')depth++;else if(ch==='}')depth--;j++;}
  const body=css.slice(open+1,j-1);
  if(/^@(media|supports)/.test(prelude))yield* blocks(body,[...context,prelude]);
  else if(!prelude.startsWith('@'))yield {context,prelude,body};
  i=j;
 }
}
function prefix(selector){
 return selector.split(',').map(sel=>{sel=sel.trim();if(!sel)return sel;
  if(sel.startsWith(':root'))return 'html[data-theme=light]'+sel.slice(5);
  if(/^html\b/.test(sel))return 'html[data-theme=light]'+sel.slice(4);
  return 'html[data-theme=light] '+sel;}).join(',');
}
function declarations(body){
 const out=[];for(const part of body.split(/;(?![^(]*\))/)){const k=part.indexOf(':');if(k<0)continue;const prop=part.slice(0,k).trim().toLowerCase(),value=part.slice(k+1).trim();const colour=COLOR.test(value);COLOR.lastIndex=0;if((prop.startsWith('--')&&colour)||((FG.test(prop)||BG.test(prop))&&(colour||/^(none|transparent|inherit|currentcolor|initial|unset|var\()/i.test(value))))out.push([prop,value]);}
 return out;
}
const files=(await readdir(new URL('assets/',`file://${root}`))).filter(f=>f.endsWith('.css')&&!EXCLUDE.has(f)).sort();
const outDir=root+'assets/light/';await rm(outDir,{recursive:true,force:true});await mkdir(outDir,{recursive:true});
let count=0,written=0;
for(const file of files){
 const css=await readFile(root+'assets/'+file,'utf8');let chunk='';
 for(const {context,prelude,body} of blocks(css)){
  if(/@keyframes/.test(prelude))continue;
  const decls=declarations(body);if(!decls.length)continue;
  const mapped=decls.map(([prop,value])=>{const role=BG.test(prop)||/^--.*(bg|background|panel|surface|card|base|paper)/.test(prop)?'bg':'fg';return `${prop}:${value.replace(COLOR,m=>mapColor(m,role,/^(color|--.*(ink|text|muted|faint|fg|accent|blue|gold|green|red))$/.test(prop)))}`;}).join(';');
  let rule=`${prefix(prelude)}{${mapped}}`;for(const media of [...context].reverse())rule=`${media}{${rule}}`;chunk+=rule+'\n';count+=decls.length;
 }
 // One light file per source stylesheet, loaded right after it: page styles stay page-scoped.
 await writeFile(outDir+file,`/* GENERATED from ${file} by scripts/build-light-theme.mjs — manual fixes go to theme-light-fixes.css */\n${chunk}`);written++;
}
let output='/* GENERATED: SVG presentation attributes written by scripts. */\n';
// SVG presentation attributes written by scripts (CSS overrides attributes).
const attrs=new Set();for(const f of (await readdir(new URL('assets/',`file://${root}`))).filter(f=>f.endsWith('.js')&&!['landing.js','market-demo.js','market-demo-engine.js'].includes(f))){const js=await readFile(root+'assets/'+f,'utf8');for(const m of js.matchAll(/(fill|stroke|stop-color)="(#[0-9a-fA-F]{3,8})"/g))attrs.add(m[1]+'|'+m[2]);}
for(const item of [...attrs].sort()){const [attr,color]=item.split('|');output+=`html[data-theme=light] [${attr}="${color}"]{${attr}:${mapColor(color,attr==='fill'&&!/^#(1|2)/.test(color)?'fg':'fg')}}\n`;count++;}
await writeFile(root+'assets/theme-light.css',output);
console.log(`light theme: ${count} colour declarations, ${written} files in assets/light/, SVG attributes in theme-light.css`);
