/** Replay real captured bytes through the terminal emulator; print the visible screen. */
import fs from 'node:fs';
import path from 'node:path';
import xterm from '@xterm/headless';
import {output} from './prepare.mjs';
const rows=Number(process.argv[2]??32),cols=Number(process.argv[3]??110);
const terminal=new xterm.Terminal({rows,cols,scrollback:5000,allowProposedApi:true});
await new Promise(resolve=>terminal.write(fs.readFileSync(path.join(output,process.env.PI_GOAL_TERMINAL_NAME??'terminal','terminal.bin')),resolve));
const buffer=terminal.buffer.active;
const lines=[];
for(let y=buffer.viewportY;y<buffer.viewportY+rows;y++)lines.push(buffer.getLine(y)?.translateToString(true)??'');
console.log(lines.join('\n'));
terminal.dispose();
