import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {validateNews} from '../lib/news.mjs';
const source=process.argv[2];if(!source){console.error('Usage: node scripts/import-news.mjs /path/to/approved-feed.json');process.exit(1)}
try{const items=validateNews(JSON.parse(await readFile(source,'utf8'))),directory=process.env.ORBITA_DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url));await mkdir(directory,{recursive:true});const target=path.join(directory,'news.json');await writeFile(target+'.tmp',JSON.stringify({items}),{mode:0o600});await rename(target+'.tmp',target);console.log(`Imported ${items.length} news records.`)}catch(e){console.error(e.message);process.exit(1)}
