import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const pub=new URL('../public/',import.meta.url);
test('light theme is generated for every cabinet/admin stylesheet and stays scoped to html[data-theme=light]',async()=>{
 const light=await readdir(new URL('assets/light/',pub));
 for(const file of light){const css=await readFile(new URL('assets/light/'+file,pub),'utf8');for(const line of css.split('\n').filter(l=>l&&!l.startsWith('/*')))assert.match(line,/html\[data-theme=light\]/,file+': '+line.slice(0,80));}
 const pages=(await readdir(pub)).filter(f=>f.endsWith('.html'));
 for(const page of pages){const html=await readFile(new URL(page,pub),'utf8');if(!html.includes('theme-init.js'))continue;
  for(const [,name] of html.matchAll(/href="\/?assets\/([a-z0-9-]+\.css)"/g))if(!name.startsWith('theme-light'))assert.ok(html.includes(`/assets/light/${name}`),`${page} loads ${name} without its light counterpart`);
  assert.ok(html.indexOf('theme-init.js')<html.indexOf('stylesheet'),page+': theme is applied before styles (no flash)');}
 const landing=await readFile(new URL('index.html',pub),'utf8');assert.ok(!landing.includes('theme-init.js'),'landing stays dark');
});
test('generated light files are up to date with the dark stylesheets',async()=>{
 // Every dark stylesheet that declares colours has a light counterpart (run scripts/build-light-theme.mjs after edits).
 const light=new Set(await readdir(new URL('assets/light/',pub)));
 for(const file of (await readdir(new URL('assets/',pub))).filter(f=>f.endsWith('.css')&&!['landing.css','market-demo.css','theme-light.css','theme-light-fixes.css'].includes(f)))assert.ok(light.has(file),file+' has no light version');
});
