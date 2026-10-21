import assert from "node:assert/strict";
globalThis.location = {pathname:"/w/old123/data/"};
const {api,ApiError}=await import("../src/api.ts");
const originalFetch=globalThis.fetch;
try {
  // A legacy server serves HTML for workspace paths it doesn't understand.
  // This used to become {}, crashing the next render and every refresh.
  globalThis.fetch=async url=>{
    assert.equal(url,"/w/new456/api/state");
    return new Response("<!doctype html><html></html>",{headers:{"content-type":"text/html"}});
  };
  await assert.rejects(api.workspaceState("new456"),error=>error instanceof ApiError && error.status===502 && /Restart/.test(error.message));
  globalThis.fetch=async()=>new Response("null",{headers:{"content-type":"application/json"}});
  await assert.rejects(api.state(),/invalid app data/);
  globalThis.fetch=async url=>{
    assert.equal(url,"/w/new456/api/state","the target is not prefixed by the previous workspace");
    return Response.json({workspace:{id:"new456"},root:"/workspace",types:[]});
  };
  assert.equal((await api.workspaceState("new456")).workspace.id,"new456");
  globalThis.location.pathname="/w/new456/data/";
  globalThis.fetch=async url=>{
    assert.equal(url,"/w/new456/api/state","refresh binds API requests to the workspace in the URL");
    return Response.json({workspace:{id:"new456"}});
  };
  assert.equal((await api.state()).workspace.id,"new456");
  globalThis.location.pathname="/w/old123/";
  globalThis.fetch=async url=>{
    assert.equal(url,"/w/old123/api/state","Back restores the original workspace API scope");
    return Response.json({workspace:{id:"old123"}});
  };
  assert.equal((await api.state()).workspace.id,"old123");
  console.log("Navigation API: legacy HTML rejected; target workspace, refresh and Back retain their workspace scope.");
} finally {globalThis.fetch=originalFetch;}
