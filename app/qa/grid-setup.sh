#!/usr/bin/env bash
# Fresh local-store workspace for qa-grid.mjs, served on :4391.
set -e
export HOME=/Users/jerryopenclaw
G=$HOME/.hermes/cache/scratch/grid-qa
pkill -f "serve --port 4391" 2>/dev/null || true
sleep 1
rm -rf "$G"; mkdir -p "$G"
export SURFACE_STORE=local SURFACE_CONFIG_DIR=$G/cfg SURFACE_DATA_DIR=$G/data
S=$HOME/Developer/Surface/cli/bin/surface
$S init "$G/v" --create "Grid QA" >/dev/null
cd "$G/v"
$S type add job >/dev/null
$S type add task >/dev/null
$S field add task status --kind select --options "To do,Doing,Done" >/dev/null
$S field add task due --kind date >/dev/null
$S field add task cost --kind number >/dev/null
$S field add task done --kind checkbox >/dev/null
$S field add task trades --kind multi_select --options "tile,plumbing,electric,paint" >/dev/null
$S field add task job --kind link --target job >/dev/null
$S field add task owner --kind text >/dev/null
for j in "Steiner Kitchen" "Baker Bath" "Ortiz Basement"; do $S new job "$j" >/dev/null; done
python3 - <<'EOF'
import subprocess
S='/Users/jerryopenclaw/Developer/Surface/cli/bin/surface'
jobs=["Steiner Kitchen","Baker Bath","Ortiz Basement"]; st=["To do","Doing","Done"]
words="Order tile;Schedule electrician;Confirm vanity;Paint trim;Rough plumbing;Install fan;Patch drywall;Order grout;Pick fixtures;Frame wall".split(";")
for i in range(36):
    a=["new","task",f"{words[i%10]} {i+1}",f"status={st[i%3]}",f"due=2026-11-{(i%27)+1:02d}",f"cost={(i*137)%2000}",f"owner={['Sam','Ana','Lee'][i%3]}",f"job=[[{jobs[i%3]}]]",f"trades={['tile','plumbing','electric','paint'][i%4]}"]
    if i%4==0: a.append("done=true")
    subprocess.run([S]+a,check=True,capture_output=True)
EOF
$S view new "All tasks" --from task --show table,board --by status --columns status,owner,due,cost,done,trades,job --key all-tasks >/dev/null
(nohup $S serve --port 4391 > "$G/serve.log" 2>&1 &)
sleep 3
echo ready
