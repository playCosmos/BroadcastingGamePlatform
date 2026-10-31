#!/usr/bin/env node
/**
 * R15i - read-only integration readiness audit for the long Yacht/GameRoom
 * stacked Draft PR chain. Live mode reads only GitHub's public pull and
 * main-branch metadata; no merge, branch edits, release or token logging.
 *
 * node server/audit-game-room-pr-stack.mjs --self-test
 * node server/audit-game-room-pr-stack.mjs --live
 * GITHUB_TOKEN=... node server/audit-game-room-pr-stack.mjs --live-ancestry
 *
 * GITHUB_TOKEN is optional; if set, it is used only as a request header.
 */
const REPOSITORY="playCosmos/BroadcastingGamePlatform";
const TIP="feature/common-game-room-r15h-cross-room-24-socket-isolation";
const ROOT_PR=33;
const REQUIRED_STAGES=81;
const API="https://api.github.com/repos/"+REPOSITORY;
const allowed=new Set(["--self-test","--live","--live-ancestry"]);
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

// Compare each exact parent SHA to the child head. Matching PR metadata
// alone cannot establish commit ancestry; these checks are read-only.
function isExactDescendant(compare,baseSha){
    return compare?.status==="ahead"
        &&Number.isSafeInteger(compare.ahead_by)&&compare.ahead_by>0
        &&compare.behind_by===0
        &&compare.merge_base_commit?.sha===baseSha;
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
    console.log("GAME_ROOM_STACK_AUDIT_SELFTEST_PASSED cases="+(cases.length+6));
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
async function verifyLiveAncestry(prs){
    // This mode intentionally requires an operator-supplied GitHub token:
    // 81 compare requests exceed the anonymous GitHub hourly API quota.
    if(!process.env.GITHUB_TOKEN)
        throw Error("authenticated GitHub access required for ancestry");
    const byHead=new Map(prs.map(p=>[p.head?.ref,p]));
    const pairs=[];
    let p=byHead.get(TIP);
    while(p){
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
    console.log("GAME_ROOM_STACK_ANCESTRY_VALID checks="+pairs.length+
        " root="+ROOT_PR+" tip=116 allParentsAncestors=true");
    console.log("GAME_ROOM_STACK_ANCESTRY_ADVISORY"+
        " merge_conflicts_not_checked=true no_merges_performed=true");
}
async function live(verifyAncestry=false){
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
    if(verifyAncestry)await verifyLiveAncestry(prs);
    console.log("GAME_ROOM_STACK_AUDIT_VALID"+
        " root="+outcome.root+" tip="+outcome.tip+
        " drafts="+outcome.draftCount+" links="+outcome.links+
        " openPRs="+outcome.openPRCount+
        " parentHeadsExact=true mainBaseExact=true");
    console.log("GAME_ROOM_STACK_AUDIT_ADVISORY"+
        " no_automatic_merge=true no_remote_field_proof=true"+
        " commit_ancestry_not_proven=true");
}
try{
    if(modes[0]==="--self-test")selfTest();
    else await live(modes[0]==="--live-ancestry");
}catch(error){
    // Avoid echoing a potentially credential-bearing URL or request headers.
    console.error("GAME_ROOM_STACK_AUDIT_FAILED"+
        " type="+(modes[0].startsWith("--live")?"metadata_or_validation":"selftest"));
    process.exitCode=1;
}
