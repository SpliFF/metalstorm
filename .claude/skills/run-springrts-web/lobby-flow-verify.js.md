# run-springrts-web reference — lobby-flow verification script

Split out of [SKILL.md](SKILL.md) (2026-09-10). Only for testing the lobby
UI itself; the discipline around it is in
[../game-browser-test/lobby-flow.md](../game-browser-test/lobby-flow.md).

## Lobby-flow verification path

Only when testing the lobby UI itself (login/register form, room browser,
create/join). The self-contained browser flow that yields a **ticking** sim
(run via chrome-devtools `evaluate_script` after navigating to
`http://localhost:8012/`):

```js
// register/login a non-admin user, then CREATE+START your own room
// (a ticking sim needs the registered host to connect — see Gotchas).
const set=(id,v)=>{const el=document.getElementById(id);const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
if (document.getElementById('login-user') && lobby.currentScreen==='login') {
  set('login-user','texdebug'); set('login-pass','texdebug123'); set('login-pass2','texdebug123');
  // Registration REQUIRES a faction (immutable sign-up choice). Leave the
  // select on its placeholder and the button refuses with "Choose a faction"
  // and you sit on the login screen — verified 2026-08-10.
  const f=document.getElementById('login-faction');
  const d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
  d.set.call(f,[...f.options].find(o=>o.value).value);
  f.dispatchEvent(new Event('change',{bubbles:true}));
  document.getElementById('login-btn').click();
}
// ...wait for lobby.currentScreen==='browser', then:
const map=lobby.maps[0].id;   // public accessor (availableMaps is private)
await lobby.createRoom('drive', map);
await lobby.addAI('null',1); await lobby.ready(true); await lobby.startGame();
// ...wait for window.test && window.__gp, then for the client's own readiness:
//   (await test.readyState()).render.terrainMeshCount > 0
// NOT lobby.currentRoom.state>=4 — an in-game client's cached room state never
// reaches Active (it has left the lobby SSE feed).
```

When the drive is done, stop the room you started: `end_game {"roomId": <id>}`.
