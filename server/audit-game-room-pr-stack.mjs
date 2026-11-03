#!/usr/bin/env node
/**
 * R15i - read-only integration readiness audit for the long Yacht/GameRoom
 * stacked Draft PR chain. Live mode reads only GitHub's public pull and
 * main-branch metadata; no merge, branch edits, release or token logging.
 *
 * node server/audit-game-room-pr-stack.mjs --self-test
 * node server/audit-game-room-pr-stack.mjs --live
 * node server/audit-game-room-pr-stack.mjs --live-ci
 * GITHUB_TOKEN=... node server/audit-game-room-pr-stack.mjs --live-ancestry
 * GITHUB_TOKEN=... node server/audit-game-room-pr-stack.mjs --integrated
 *
 * GITHUB_TOKEN is optional; if set, it is used only as a request header.
 */
const REPOSITORY="playCosmos/BroadcastingGamePlatform";
const TIP="feature/common-game-room-r15h-cross-room-24-socket-isolation";
const ROOT_PR=33;
const REQUIRED_STAGES=81;
const API="https://api.github.com/repos/"+REPOSITORY;
const allowed=new Set(["--self-test","--live","--live-ancestry","--live-ci","--integrated"]);
const modes=process.argv.slice(2);
if(modes.length!==1||!allowed.has(modes[0])){
    console.error("GAME_ROOM_STACK_AUDIT_INVALID_MODE");
    process.exit(2);
}

function audit(prs,mainSha,{tip=TIP,rootNumber=ROOT_PR,minimum=REQUIRED_STAGES}={}){
    const failures=new Set(),heads=new Map(),numbers=new Set();
    for(const p of prs){
        if(!p||!Number.isSafeInteger(p.number))continue;
        if(numbers.has(p.number))failures.add("duplicate_pr");
        numbers.add(p.number);
        if(typeof p.head?.ref!=="string")continue;
        if(heads.has(p.head.ref))failures.add("duplicate_head");
        heads.set(p.head.ref,p);
    }
    const chain=[],seen=new Set();
    let current=heads.get(tip),root=null;
    if(!current)failures.add("tip_absent");
    while(current){
        if(seen.has(current.number)){
            failures.add("cycle");break;
        }
        seen.add(current.number);
        chain.push(current);
        if(current.state!=="open"||current.draft!==true
            ||current.merged_at!=null)failures.add("not_open_draft");
        if(current.head?.repo?.full_name!==REPOSITORY
            ||current.base?.repo?.full_name!==REPOSITORY)
            failures.add("foreign_or_deleted_branch");
        if(!/^[a-f0-9]{40}$/.test(current.head?.sha||"")
            ||!/^[a-f0-9]{40}$/.test(current.base?.sha||""))
            failures.add("invalid_commit_sha");
        if(current.head.sha===current.base.sha)
            failures.add("empty_pr");
        if(current.base.ref==="main"){
            root=current;
            if(current.base.sha!==mainSha)failures.add("main_drift");
            break;
        }
        const parent=heads.get(current.base?.ref);
        if(!parent){
            failures.add("parent_missing");break;
        }
        if(parent.head?.sha!==current.base?.sha)
            failures.add("parent_head_drift");
        current=parent;
        if(chain.length>500){
            failures.add("chain_overflow");break;
        }
    }
    if(root?.number!==rootNumber)failures.add("wrong_root");
    if(chain.length<minimum)failures.add("short_chain");
    if(chain.length>prs.length)failures.add("invalid_chain");
    return {
        valid:failures.size===0,failures:[...failures].sort(),
        root:root?.number??null,tip:chain[0]?.number??null,
        links:Math.max(0,chain.length-1),
        draftCount:chain.filter(p=>p.draft===true).length,
        openPRCount:prs.filter(p=>p.state==="open").length
    };
}

// The pre-merge Draft chain was integrated in November 2026. Preserve its
// original --live modes as historical preflight checks; do NOT present them
// as an applicable post-merge audit or silently weaken their prerequisites.
// #36, #41 and #59 are deliberately CLOSED UNMERGED sibling alternatives.
const UNMERGED_SIBLINGS=new Set([36,41,59]);
const INTEGRATED_TIP_PR=116;
const COMMIT_SHA=/^[a-f0-9]{40}$/;

function mergedAudit(prs,{first=ROOT_PR,last=INTEGRATED_TIP_PR,
    excluded=UNMERGED_SIBLINGS}={}){
    const failures=new Set(),byNumber=new Map(),stages=[];
    for(const p of prs){
        if(!Number.isSafeInteger(p?.number))continue;
        if(byNumber.has(p.number))failures.add("duplicate_pr");
        byNumber.set(p.number,p);
    }
    for(let n=first;n<=last;n++){
        const p=byNumber.get(n);
        if(excluded.has(n)){
            // An excluded duplicate is not part of the canonical stack.
            if(p?.merged_at!=null)failures.add("sibling_was_merged");
            continue;
        }
        if(!p){failures.add("missing_pr");continue;}
        stages.push(p);
        if(p.state!=="closed"||typeof p.merged_at!=="string"
            ||!Number.isFinite(Date.parse(p.merged_at)))
            failures.add("not_merged");
        if(!COMMIT_SHA.test(p.head?.sha||"")
            ||!COMMIT_SHA.test(p.merge_commit_sha||""))
            failures.add("invalid_merge_sha");
        if(p.base?.ref!=="main"
            ||p.base?.repo?.full_name!==REPOSITORY)
            failures.add("not_main_base");
    }
    return {valid:failures.size===0,failures:[...failures].sort(),stages};
}

// Compare from the exact merge commit to the exact current main commit.
// A merged_at timestamp alone cannot prove the merge is still reachable
// after rebasing/force-pushing main. Both the ahead and identical results
// are valid, but any behind/diverged or wrong merge-base result is rejected.
function mergedReachable(compare,mergeSha){
    return ((compare?.status==="ahead"&&Number.isSafeInteger(compare.ahead_by)
                &&compare.ahead_by>0)
        ||(compare?.status==="identical"&&compare.ahead_by===0))
        &&compare.behind_by===0
        &&compare.merge_base_commit?.sha===mergeSha;
}

// Compare each exact parent SHA to the child head. Matching PR metadata
// alone cannot establish commit ancestry; these checks are read-only.
function isExactDescendant(compare,baseSha){
    return compare?.status==="ahead"
        &&Number.isSafeInteger(compare.ahead_by)&&compare.ahead_by>0
        &&compare.behind_by===0
        &&compare.merge_base_commit?.sha===baseSha;
}

function sameLineageSnapshot(original,latest){
    const byNumber=new Map(latest.map(p=>[p.number,p]));
    return original.every(p=>{
        const next=byNumber.get(p.number);
        return next?.state===p.state&&next?.draft===p.draft
            &&next?.head?.ref===p.head?.ref
            &&next?.head?.sha===p.head?.sha
            &&next?.base?.ref===p.base?.ref
            &&next?.base?.sha===p.base?.sha;
    });
}

const CI_GATES=[
    "Check PowerShell scripts","Check browser JavaScript",
    "Run platform regression probes","Real GameRoom Chrome Edge browser E2E",
    "Verify package","R14h packaged GameRoom graceful exit and restart",
    "R14n verify packaged Windows listener-JVM duration trend",
    "R15b verify actual packaged six-player Yacht 78-turn match",
    "R15e verify native Yacht events to all 20 authenticated member WebSockets"
];
// Fail closed if the most recent exact-head attempt of either event is
// pending or failed, even when a prior run succeeded.
function latestCi(runs,head){
    if(!Array.isArray(runs))throw Error("invalid CI run collection");
    const result={};
    for(const event of ["push","pull_request"]){
        const matches=runs.filter(r=>r?.event===event
            &&r.path===".github/workflows/platform-windows-package.yml"
            &&r.head_sha===head&&r.head_branch===TIP);
        // GitHub reruns retain their original run ID, but run_started_at
        // advances on the new attempt. An older ID may therefore be the
        // most recent failed or pending attempt. Missing timestamps block
        // an affirmative pre-merge result rather than guessing by ID.
        if(matches.length===0||matches.some(r=>
            !Number.isSafeInteger(r.id)||
            typeof r.run_started_at!=="string"||
            !Number.isFinite(Date.parse(r.run_started_at))))
            throw Error("invalid "+event+" Windows CI attempt metadata");
        matches.sort((a,b)=>Date.parse(b.run_started_at)
            -Date.parse(a.run_started_at)||b.id-a.id);
        const run=matches[0];
        if(run.status!=="completed"||run.conclusion!=="success")
            throw Error("latest "+event+" Windows CI not successful");
        result[event]=run;
    }
    return result;
}
function ciJobValid(jobs){
    if(!Array.isArray(jobs)||jobs.length!==1)return false;
    const job=jobs[0];
    if(job.name!=="package"||job.status!=="completed"
        ||job.conclusion!=="success"||!Array.isArray(job.steps))
        return false;
    return CI_GATES.every(name=>job.steps.filter(s=>
        s.name===name&&s.status==="completed"
            &&s.conclusion==="success").length===1);
}
function sample(n,head,base,baseSha,sha){
    return {
        number:n,state:"open",draft:true,merged_at:null,
        head:{ref:head,sha,repo:{full_name:REPOSITORY}},
        base:{ref:base,sha:baseSha,repo:{full_name:REPOSITORY}}
    };
}
function selfTest(){
    const a="a".repeat(40),b="b".repeat(40),c="c".repeat(40);
    const pristine=[
        sample(1,"feature/yacht-base","main",a,b),
        sample(2,"feature/yacht-child","feature/yacht-base",b,c)
    ];
    const evaluate=p=>audit(p,a,{tip:"feature/yacht-child",
        rootNumber:1,minimum:2});
    if(!evaluate(pristine).valid)throw Error("valid lineage rejected");
    const cases=[
        {name:"parent drift",mutate:p=>{p[1].base.sha=a;},
            expected:"parent_head_drift"},
        {name:"missing parent",mutate:p=>{p.pop();},
            expected:"tip_absent"},
        {name:"wrong base branch",mutate:p=>{
            p[1].base.ref="feature/missing-parent";},
            expected:"parent_missing"},
        {name:"wrong root",mutate:p=>{p[0].base.ref="feature/missing";},
            expected:"parent_missing"},
        {name:"main drift",mutate:p=>{p[0].base.sha=c;},
            expected:"main_drift"},
        {name:"merged or closed",mutate:p=>{p[1].state="closed";},
            expected:"not_open_draft"},
        {name:"draft removed",mutate:p=>{p[0].draft=false;},
            expected:"not_open_draft"},
        {name:"duplicate head",mutate:p=>{p.push({...p[0],number:5});},
            expected:"duplicate_head"},
        {name:"duplicate number",mutate:p=>{
            p.push({...p[0],head:{...p[0].head,ref:"feature/other"}});},
            expected:"duplicate_pr"},
        {name:"bad commit",mutate:p=>{p[1].head.sha="bad";},
            expected:"invalid_commit_sha"},
        {name:"foreign source",mutate:p=>{
            p[1].head.repo.full_name="foreign/repo";},
            expected:"foreign_or_deleted_branch"},
        {name:"cycle",mutate:p=>{
            p[0].base.ref=p[1].head.ref;
            p[0].base.sha=p[1].head.sha;},
            expected:"cycle"}
    ];
    for(const {name,mutate,expected} of cases){
        const clone=structuredClone(pristine);
        mutate(clone);
        const outcome=evaluate(clone);
        if(outcome.valid||!outcome.failures.includes(expected))
            throw Error("mutation unexpectedly accepted: "+name);
    }
    const good={status:"ahead",ahead_by:2,behind_by:0,
        merge_base_commit:{sha:a}};
    if(!isExactDescendant(good,a)
        ||isExactDescendant({...good,status:"diverged"},a)
        ||isExactDescendant({...good,behind_by:1},a)
        ||isExactDescendant({...good,ahead_by:0},a)
        ||isExactDescendant({...good,merge_base_commit:{sha:b}},a))
        throw Error("ancestry comparison contract rejected");
    const original=structuredClone(pristine);
    const changedHead=structuredClone(pristine);
    changedHead[1].head.sha=b;
    const changedBase=structuredClone(pristine);
    changedBase[1].base.sha=a;
    if(!sameLineageSnapshot(pristine,original)
        ||sameLineageSnapshot(pristine,changedHead)
        ||sameLineageSnapshot(pristine,changedBase))
        throw Error("lineage snapshot contract rejected");
    const green=[
        {id:10,event:"push",path:".github/workflows/platform-windows-package.yml",
            head_sha:c,head_branch:TIP,status:"completed",conclusion:"success",
            run_started_at:"2026-11-01T00:00:00Z"},
        {id:11,event:"pull_request",path:".github/workflows/platform-windows-package.yml",
            head_sha:c,head_branch:TIP,status:"completed",conclusion:"success",
            run_started_at:"2026-11-01T00:00:00Z"}
    ];
    const greenJobs=[{name:"package",status:"completed",conclusion:"success",
        steps:CI_GATES.map(name=>({name,status:"completed",conclusion:"success"}))}];
    if(latestCi(green,c).push.id!==10||!ciJobValid(greenJobs))
        throw Error("green CI rejected");
    const attempts=[
        [green[0]],
        [...green,{...green[0],id:12,status:"in_progress",
            run_started_at:"2026-11-01T00:01:00Z"}],
        [...green,{...green[1],id:13,conclusion:"failure",
            run_started_at:"2026-11-01T00:01:00Z"}],
        [{...green[0],head_sha:a},green[1]],
        // Older run ID rerun after the green run; ID ordering is unsafe.
        [...green,{...green[0],id:9,status:"in_progress",
            run_started_at:"2026-11-01T00:02:00Z"}],
        [...green,{...green[1],id:8,conclusion:"failure",
            run_started_at:"2026-11-01T00:02:00Z"}],
        [...green,{...green[0],id:9,run_started_at:null}]
    ];
    for(const runs of attempts){
        let rejected=false;
        try{latestCi(runs,c);}catch{rejected=true;}
        if(!rejected)throw Error("bad CI run accepted");
    }
    const missing=structuredClone(greenJobs);missing[0].steps.pop();
    const failed=structuredClone(greenJobs);failed[0].steps[0].conclusion="failure";
    if(ciJobValid(missing)||ciJobValid(failed))throw Error("bad gates accepted");
    // Post-integration audit: closed/merged is distinct from merely closed.
    const d="d".repeat(40),e="e".repeat(40);
    const merged=structuredClone(pristine).map((p,i)=>({
        ...p,state:"closed",draft:false,
        merged_at:"2026-11-03T08:00:00Z",
        merge_commit_sha:i===0?d:e,
        base:{...p.base,ref:"main"}
    }));
    const mergedCheck=list=>mergedAudit(list,{
        first:1,last:2,excluded:new Set()
    });
    if(!mergedCheck(merged).valid)throw Error("valid integrated stack rejected");
    const mergedCases=[
        {name:"missing merged PR",mutate:p=>{p.pop();},
            expected:"missing_pr"},
        {name:"closed without merge",mutate:p=>{p[1].merged_at=null;},
            expected:"not_merged"},
        {name:"reopened PR",mutate:p=>{p[0].state="open";},
            expected:"not_merged"},
        {name:"missing merge commit",mutate:p=>{p[0].merge_commit_sha=null;},
            expected:"invalid_merge_sha"},
        {name:"wrong main base",mutate:p=>{p[1].base.ref="feature/foo";},
            expected:"not_main_base"},
        {name:"duplicate merged PR",mutate:p=>{p.push({...p[0]});},
            expected:"duplicate_pr"}
    ];
    for(const {name,mutate,expected} of mergedCases){
        const candidate=structuredClone(merged);
        mutate(candidate);
        const result=mergedCheck(candidate);
        if(result.valid||!result.failures.includes(expected))
            throw Error("integrated mutation unexpectedly accepted: "+name);
    }
    if(mergedAudit(merged,{first:1,last:2,excluded:new Set([1])}).valid)
        throw Error("merged sibling accepted");
    const reachable={status:"ahead",ahead_by:5,behind_by:0,
        merge_base_commit:{sha:d}};
    const identical={...reachable,status:"identical",ahead_by:0};
    if(!mergedReachable(reachable,d)||!mergedReachable(identical,d)
        ||mergedReachable({...reachable,status:"diverged"},d)
        ||mergedReachable({...reachable,behind_by:1},d)
        ||mergedReachable({...reachable,merge_base_commit:{sha:e}},d)
        ||mergedReachable({...reachable,ahead_by:0},d))
        throw Error("post-merge ancestry acceptance broken");
    console.log("GAME_ROOM_STACK_AUDIT_SELFTEST_PASSED cases="+
        (cases.length+19+mergedCases.length+7));
}
async function api(path){
    const token=process.env.GITHUB_TOKEN||"";
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),15000);
    try{
        const response=await fetch(API+path,{
            headers:{
                Accept:"application/vnd.github+json",
                "User-Agent":"game-room-readonly-stack-audit",
                ...(token?{Authorization:"Bearer "+token}:{})
            },redirect:"error",signal:controller.signal
        });
        if(!response.ok)throw Error("GitHub metadata unavailable");
        const length=Number(response.headers.get("content-length")||"0");
        if(length>4_000_000)throw Error("GitHub metadata too large");
        return await response.json();
    }finally{clearTimeout(timeout);}
}
async function verifyLiveAncestry(prs,mainSha){
    // This mode intentionally requires an operator-supplied GitHub token:
    // 81 compare requests exceed the anonymous GitHub hourly API quota.
    if(!process.env.GITHUB_TOKEN)
        throw Error("authenticated GitHub access required for ancestry");
    const byHead=new Map(prs.map(p=>[p.head?.ref,p]));
    const pairs=[],lineage=[];
    let p=byHead.get(TIP);
    while(p){
        lineage.push(p);
        pairs.push({base:p.base.sha,head:p.head.sha});
        if(p.base.ref==="main")break;
        p=byHead.get(p.base.ref);
    }
    if(pairs.length!==REQUIRED_STAGES||p?.number!==ROOT_PR)
        throw Error("unexpected integration chain size");
    // Small batches prevent unnecessary GitHub secondary rate-limit pressure.
    for(let i=0;i<pairs.length;i+=3){
        const group=pairs.slice(i,i+3);
        const checked=await Promise.all(group.map(async pair=>{
            const result=await api("/compare/"+pair.base+"..."+pair.head+"?per_page=1");
            return isExactDescendant(result,pair.base);
        }));
        if(checked.some(value=>!value))
            throw Error("non-descendant PR pair at index "+i);
    }
    // Fail closed if any audited PR ref or main has moved while the
    // individually pinned compare requests were running.
    const latest=[];
    for(let page=1;page<=5;page++){
        const batch=await api("/pulls?state=open&per_page=100&page="+page);
        if(!Array.isArray(batch)||batch.length>100)
            throw Error("invalid refreshed PR list");
        latest.push(...batch);
        if(batch.length<100)break;
        if(page===5)throw Error("refreshed PR pagination overflow");
    }
    const refreshedMain=await api("/branches/main");
    if(refreshedMain?.commit?.sha!==mainSha
        ||!sameLineageSnapshot(lineage,latest))
        throw Error("lineage changed during ancestry audit");
    console.log("GAME_ROOM_STACK_ANCESTRY_VALID checks="+pairs.length+
        " root="+ROOT_PR+" tip=116 allParentsAncestors=true");
    console.log("GAME_ROOM_STACK_ANCESTRY_ADVISORY"+
        " merge_conflicts_not_checked=true no_merges_performed=true");
}
// Read-only, exact-head dual-CI gate. Does not prove sequential merge.
async function verifyLiveCi(prs,mainSha){
    const tip=prs.find(p=>p.head?.ref===TIP);
    const sha=tip.head.sha;
    const result=await api("/actions/runs?head_sha="+sha+"&per_page=100&page=1");
    if(!Array.isArray(result?.workflow_runs)
        ||!Number.isSafeInteger(result.total_count)
        ||result.total_count>100)throw Error("incomplete workflow evidence");
    const chosen=latestCi(result.workflow_runs,sha);
    for(const event of ["push","pull_request"]){
        const jobs=await api("/actions/runs/"+chosen[event].id+
            "/jobs?per_page=100");
        if(jobs?.total_count!==1||!ciJobValid(jobs.jobs))
            throw Error("required Windows CI gates did not pass");
    }
    const refreshed=await api("/pulls?state=open&per_page=100&page=1");
    const main=await api("/branches/main");
    if(!Array.isArray(refreshed)||refreshed.length>=100
        ||!sameLineageSnapshot(prs,refreshed)
        ||main?.commit?.sha!==mainSha)
        throw Error("ref changed during CI audit");
    console.log("GAME_ROOM_STACK_CI_VALID tip="+tip.number+
        " pushRun="+chosen.push.id+" prRun="+chosen.pull_request.id+
        " gates="+CI_GATES.length+" dualSuccess=true");
    console.log("GAME_ROOM_STACK_CI_ADVISORY"+
        " tip_only=true no_sequential_merge_test=true"+
        " no_external_field_acceptance=true");
}
// Operator-only: all 81 canonical stages must have a real merge commit
// reachable from main. No branch-ref presence is required, so this mode
// remains valid after safely deleting merged feature branches.
async function closedPulls(){
    const prs=[];
    for(let page=1;page<=5;page++){
        const batch=await api("/pulls?state=closed&per_page=100&page="+page);
        if(!Array.isArray(batch)||batch.length>100)
            throw Error("invalid closed PR collection");
        prs.push(...batch);
        if(batch.length<100)return prs;
    }
    throw Error("closed PR pagination exceeds supported audit limit");
}
async function integrated(){
    // 81 compare requests require an operator token; ordinary hosted CI
    // runs the offline negative fixtures only, never live GitHub metadata.
    if(!process.env.GITHUB_TOKEN)
        throw Error("authenticated GitHub access required for post-merge audit");
    const prs=await closedPulls();
    const main=await api("/branches/main");
    const mainSha=main?.commit?.sha;
    if(!COMMIT_SHA.test(mainSha||""))
        throw Error("invalid main SHA");
    const audit=mergedAudit(prs);
    if(!audit.valid||audit.stages.length!==REQUIRED_STAGES){
        console.error("GAME_ROOM_STACK_INTEGRATED_BLOCKED reasons="+
            audit.failures.join(",")+" stages="+audit.stages.length);
        process.exitCode=1;return;
    }
    for(let i=0;i<audit.stages.length;i+=3){
        const group=audit.stages.slice(i,i+3);
        const verified=await Promise.all(group.map(async p=>{
            const compare=await api("/compare/"+
                p.merge_commit_sha+"..."+mainSha+"?per_page=1");
            return mergedReachable(compare,p.merge_commit_sha);
        }));
        if(verified.some(valid=>!valid))
            throw Error("merged commit not reachable from main at stage "+i);
    }
    // Fail closed on changes during the long multi-request ancestry audit.
    const latest=await closedPulls();
    const latestAudit=mergedAudit(latest);
    const latestByNumber=new Map(latestAudit.stages.map(p=>[p.number,p]));
    const latestMain=await api("/branches/main");
    if(!latestAudit.valid||latestMain?.commit?.sha!==mainSha
        ||audit.stages.some(p=>{
            const next=latestByNumber.get(p.number);
            return next?.merged_at!==p.merged_at
                ||next?.merge_commit_sha!==p.merge_commit_sha
                ||next?.head?.sha!==p.head.sha;
        }))
        throw Error("integrated PR or main ref changed during audit");
    console.log("GAME_ROOM_STACK_INTEGRATED_VALID merged="+
        audit.stages.length+" reachable="+audit.stages.length+
        " root="+ROOT_PR+" tip="+INTEGRATED_TIP_PR+
        " mainSha="+mainSha);
    console.log("GAME_ROOM_STACK_INTEGRATED_ADVISORY"+
        " historical_premerge_modes_not_applicable=true"+
        " real_field_acceptance_not_proven=true"+
        " no_branch_deletion_or_release=true");
}
async function live(mode){
    const prs=[];
    // GitHub exposes at most 100 PRs per page. Bound pagination and fail
    // closed rather than claiming a healthy partial lineage.
    for(let page=1;page<=5;page++){
        const batch=await api("/pulls?state=open&per_page=100&page="+page);
        if(!Array.isArray(batch)||batch.length>100)throw Error("invalid PR list");
        prs.push(...batch);
        if(batch.length<100)break;
        if(page===5)throw Error("PR pagination exceeds supported audit limit");
    }
    const main=await api("/branches/main");
    if(!/^[a-f0-9]{40}$/.test(main?.commit?.sha||""))
        throw Error("main SHA not available");
    const outcome=audit(prs,main.commit.sha);
    if(!outcome.valid){
        console.error("GAME_ROOM_STACK_AUDIT_BLOCKED reasons="+
            outcome.failures.join(",")+" links="+outcome.links);
        process.exitCode=1;return;
    }
    if(mode==="--live-ancestry")await verifyLiveAncestry(prs,main.commit.sha);
    if(mode==="--live-ci")await verifyLiveCi(prs,main.commit.sha);
    console.log("GAME_ROOM_STACK_AUDIT_VALID"+
        " root="+outcome.root+" tip="+outcome.tip+
        " drafts="+outcome.draftCount+" links="+outcome.links+
        " openPRs="+outcome.openPRCount+
        " parentHeadsExact=true mainBaseExact=true");
    console.log("GAME_ROOM_STACK_AUDIT_ADVISORY"+
        " no_automatic_merge=true no_remote_field_proof=true"+
        " commit_ancestry_not_proven="+(mode==="--live-ancestry"?"false":"true"));
}
try{
    if(modes[0]==="--self-test")selfTest();
    else if(modes[0]==="--integrated")await integrated();
    else await live(modes[0]);
}catch(error){
    // Avoid echoing a potentially credential-bearing URL or request headers.
    console.error("GAME_ROOM_STACK_AUDIT_FAILED"+
        " type="+(modes[0]==="--self-test"?"selftest":"metadata_or_validation"));
    process.exitCode=1;
}
