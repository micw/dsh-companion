/** Isolated desktop VS Code smoke; all DSH services are mocked and no user Runtime is touched. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from '../vscode/node_modules/esbuild/lib/main.js';
import { sampleModels, sampleSearch } from '../tests/settings-fixture.mjs';
import { createVSIX } from '../vscode/node_modules/@vscode/vsce/out/api.js';
const root = await mkdtemp(join(tmpdir(), 'companion-settings-native-'));
try {
const extension = join(root, 'extension');
const resultPath = join(root, 'result.json');
let fixtureVsix = '';
if (process.env.DSH_COMPANION_SMOKE_INSTALL === '1') {
  const fixture = join(root, 'install-fixture'); await mkdir(fixture);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'version-install-fixture', publisher: 'internal-test', version: '1.0.0',
    displayName: 'Isolated version install fixture', description: 'Temporary native test only', license: 'MIT', engines: { vscode: '^1.93.0' }, extensionKind: ['workspace'], main: './extension.js', activationEvents: [] }));
  await writeFile(join(fixture, 'extension.js'), 'exports.activate=()=>{};');
  await writeFile(join(fixture, 'README.md'), '# Isolated test fixture\n');
  fixtureVsix = join(root, 'fixture.vsix');
  await createVSIX({ cwd: fixture, packagePath: fixtureVsix, dependencies: false, allowMissingRepository: true });
}
await mkdir(extension); await mkdir(join(root, 'user-data', 'User'), { recursive: true }); await mkdir(join(root, 'extensions'));
await mkdir(join(extension, 'media'));
for (const file of ['settings-editor.css', 'settings-editor.js', 'settings-state.js']) await writeFile(join(extension, 'media', file), await readFile(new URL('../vscode/media/' + file, import.meta.url)));
await writeFile(join(extension, 'media', 'settings-editor.js'), (await readFile(join(extension, 'media', 'settings-editor.js'), 'utf8')) + `\nwindow.addEventListener('message',async({data})=>{if(data?.type!=='nativeVersionSmoke')return;const wait=()=>new Promise(r=>setTimeout(r,50));const find=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);document.querySelector('[data-category="version"]').click();for(let n=0;n<100&&(!find('Check for Updates')||find('Check for Updates').disabled);n++)await wait();find('Check for Updates').click();for(let n=0;n<100&&find('Install update and restart').disabled;n++)await wait();find('Install update and restart').click();});`);
const manifest = JSON.parse(await readFile(new URL('../vscode/package.json', import.meta.url), 'utf8'));
await writeFile(join(extension, 'package.json'), JSON.stringify({ name: 'companion-settings-smoke', publisher: 'internal-test', version: '0.0.0', engines: manifest.engines,
  main: './extension.js', activationEvents: ['onStartupFinished'], contributes: { customEditors: manifest.contributes.customEditors } }));
await writeFile(join(root, 'user-data', 'User', 'settings.json'), JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'workbench.enableExperiments': false, 'update.mode': 'none', 'files.autoSave': 'off', 'workbench.startupEditor': 'none' }));
const modelStub = `export const DSH_ORIGIN='http://127.0.0.1:3081'; export const PACKAGED_DSH_ORIGIN='http://127.0.0.1:3082'; export class DshHttpError extends Error{}; export async function exchangeLaunchUrl(){throw Error('Unexpected authentication')}; export class DshClient {static async connect(){globalThis.__settingsSmokeConnectionReady=true;return {dispose:async()=>{},watchConnection:f=>{f('connected');return ()=>{}},providerSettings:async()=>(${JSON.stringify(sampleModels)}),searchSettings:async()=>(${JSON.stringify(sampleSearch)})}}};`;
const sourcePath = resolve(new URL('../vscode/src/settingsEditor.ts', import.meta.url).pathname);
const entry = `import * as vscode from 'vscode'; import {writeFile} from 'node:fs/promises'; import {SettingsEditor} from ${JSON.stringify(sourcePath)};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f){for(let n=0;n<100;n++){if(f())return;await wait(100)}throw Error('Native editor state timed out')}
export async function activate(context){
 const prior=context.globalState.get('nativeSmokeRestart');if(prior){await context.globalState.update('nativeSmokeRestart',undefined);await writeFile(${JSON.stringify(resultPath)},JSON.stringify({ok:true,checkpoints:[...prior,'canonical window restart reactivated isolated Extension Host']}));await vscode.commands.executeCommand('workbench.action.closeWindow');return;}
 let restarting=false;
 const smokeContext=Object.create(context);Object.defineProperty(smokeContext,'secrets',{value:{get:async()=> 'smoke-cookie',store:async()=>{}}});
 let doc;const editor=new SettingsEditor(smokeContext,Promise.resolve({origin:'http://127.0.0.1:3082',clientModule:'mock'}),()=>{});
 const original=editor.openCustomDocument.bind(editor);editor.openCustomDocument=async(...args)=>{doc=await original(...args);return doc};
 const tab=()=>vscode.window.tabGroups.all.flatMap(g=>g.tabs).find(t=>t.input instanceof vscode.TabInputCustom&&t.input.viewType==='dshCompanion.settingsEditor');
 const checkpoints=[];
 try{
  await editor.open();await until(()=>!!tab());checkpoints.push('opened virtual resource');
  await until(()=>globalThis.__settingsSmokeConnectionReady===true);checkpoints.push('native webview scripts and IPC loaded');
  await editor.panel.webview.postMessage({type:'nativeVersionSmoke'});await until(()=>globalThis.__versionSmokeInstalled===true);checkpoints.push('Version tab check and confirmed-install IPC with mocked installer');
  const fixtureVsix=${JSON.stringify(fixtureVsix)};
  if(fixtureVsix){await vscode.commands.executeCommand('workbench.extensions.installExtension',vscode.Uri.file(fixtureVsix));await until(()=>vscode.extensions.getExtension('internal-test.version-install-fixture')?.packageJSON.version==='1.0.0');checkpoints.push('canonical VSIX installation completed in isolated profile');}
  await editor.open();if(vscode.window.tabGroups.all.flatMap(g=>g.tabs).filter(t=>t.input instanceof vscode.TabInputCustom).length!==1)throw Error('Duplicate Settings editor');checkpoints.push('singleton focus');
  doc.dirty=true;editor.changes.fire({document:doc});await until(()=>tab().isDirty);checkpoints.push('native dirty marker');
  doc.save=async()=>{doc.dirty=false};await vscode.commands.executeCommand('workbench.action.files.save');await until(()=>!tab().isDirty);checkpoints.push('native Save clears dirty');
  await vscode.workspace.getConfiguration('files').update('autoSave','afterDelay',vscode.ConfigurationTarget.Global);
  doc.dirty=true;editor.changes.fire({document:doc});await wait(1800);if(!doc.dirty||!tab().isDirty)throw Error('Autosave submitted a draft');checkpoints.push('autosave denied');
  doc.dirty=false;await vscode.commands.executeCommand('workbench.action.files.save');await until(()=>!tab().isDirty);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');await until(()=>!tab());checkpoints.push('native close');
  if(${JSON.stringify(process.env.DSH_COMPANION_SMOKE_RESTART === '1')}){await context.globalState.update('nativeSmokeRestart',checkpoints);restarting=true;await vscode.commands.executeCommand('workbench.action.reloadWindow');return;}
  await writeFile(${JSON.stringify(resultPath)},JSON.stringify({ok:true,checkpoints}));
 }catch(e){if(!restarting)await writeFile(${JSON.stringify(resultPath)},JSON.stringify({ok:false,message:e.message,checkpoints}));}
 finally{if(!restarting){if(doc)doc.dirty=false;try{await vscode.commands.executeCommand('workbench.action.files.save')}catch{}await vscode.commands.executeCommand('workbench.action.closeWindow')}}
}`;
await build({ stdin: { contents: entry, resolveDir: extension, sourcefile: 'native-smoke.ts', loader: 'ts' }, bundle: true, platform: 'node', external: ['vscode'], outfile: join(extension, 'extension.js'),
  plugins: [{ name: 'isolate-runtime', setup(b) {
    b.onResolve({filter:/^\.\/dshClient$/},()=>({path:'mock-client',namespace:'mock'}));
    b.onResolve({filter:/^\.\/runtimeInstaller$/},()=>({path:'mock-runtime',namespace:'mock'}));
    b.onResolve({filter:/^\.\/versionHost$/},()=>({path:'mock-version',namespace:'mock'}));
    b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='mock-client'?modelStub:args.path==='mock-version'?`export function createVersionController(context,publish){let available=false;const snapshot=()=>({installedVersion:'0.2.0',target:'Isolated native fixture',channel:'master',phase:available?'available':'idle',available:available?{version:'0.3.0',size:1,publishedAt:'2026-10-10T00:00:00Z',releaseUrl:'https://github.com/micw/dsh-companion/releases/tag/master-build'}:null,canInstall:available,blockedReason:null,progress:null,message:'Native fixture'});return{snapshot,load:async()=>publish(snapshot()),check:async()=>{available=true;publish(snapshot())},install:async()=>{globalThis.__versionSmokeInstalled=true;publish(snapshot())},dispose(){}}}`:'export async function connectRuntime(){throw Error("Unexpected Runtime start")} export function companionLifecycleRoot(){throw Error("Unexpected update lock")}',loader:'js'}));
  } }],
});
console.log('Launching isolated VS Code UI smoke');
const cli = spawn(process.env.DSH_COMPANION_CODE ?? 'code', ['--new-window', '--user-data-dir', join(root, 'user-data'), '--extensions-dir', join(root, 'extensions'), '--extensionDevelopmentPath', extension, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'], { stdio: ['ignore', 'pipe', 'pipe'] });
cli.on('error', error => { console.error(`Native VS Code launch failed: ${error.message}`); });
let output=''; cli.stdout.on('data', x=>{output=(output+x).slice(-4096)}); cli.stderr.on('data', x=>{output=(output+x).slice(-4096)});
  let result;
  for(let n=0;n<900;n++) {
    try { result=JSON.parse(await readFile(resultPath,'utf8'));break; } catch(e) { if(e.code!=='ENOENT')throw e; }
    await new Promise(r=>setTimeout(r,100));
  }
  if(!result)throw Error('Native Settings smoke timed out: '+output.slice(-1500));
  console.log(JSON.stringify(result)); if(!result.ok)throw Error(result.message);
  await new Promise(r=>setTimeout(r,1500));
}finally{if(process.env.DSH_COMPANION_SMOKE_KEEP === '1') console.log(`Native smoke data retained at ${root}`); else await rm(root,{recursive:true,force:true})}
