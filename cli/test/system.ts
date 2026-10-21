import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"surface-system-test-"));
process.env.SURFACE_CONFIG_DIR=tmp;
delete process.env.SURFACE_SUPABASE_URL; delete process.env.SURFACE_PUBLISHABLE_KEY;
const {signedInAccount,installedVersion,systemInfo}=await import("../src/system.ts");
try {
  assert.equal(signedInAccount(),null);
  fs.writeFileSync(path.join(tmp,"cloud.json"),JSON.stringify({url:"https://team.supabase.co",publishableKey:"public-key"}));
  fs.writeFileSync(path.join(tmp,"session.json"),JSON.stringify({"sb-team-auth-token":JSON.stringify({access_token:"private-access",refresh_token:"private-refresh",user:{id:"signup-user-id",email:"user@example.com",user_metadata:{full_name:"Team Member"}}}),"sb-other-auth-token":JSON.stringify({user:{id:"wrong-project",email:"other@example.com"}})}));
  assert.deepEqual(signedInAccount(),{id:"signup-user-id",email:"user@example.com",name:"Team Member"});
  const info=systemInfo(); assert.equal(info.account?.id,"signup-user-id");
  assert.equal(JSON.stringify(info).includes("private-"),false);
  assert.equal(installedVersion().number,"0.1.0");assert.match(installedVersion().commit!,/^[a-f0-9]{40}$/);
  fs.writeFileSync(path.join(tmp,"session.json"),JSON.stringify({"sb-team-auth-token":"broken"})); assert.equal(signedInAccount(),null);
  fs.writeFileSync(path.join(tmp,"session.json"),"{}");assert.equal(signedInAccount(),null);
  console.log("System info: actual signup identity, correct cloud, no exposed credentials, local/signed-out display and installed revision passed.");
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
