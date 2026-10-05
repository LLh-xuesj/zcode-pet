'use strict';
// page.js — 注入到 ZCode 窗口的页面脚本模板(气泡/菜单/成就墙/添加 API 面板)。
// ⚠ 这里的字符串就是页面代码:任何改动都是"页面模板改动",必须同步升 VER/MENUV/CLAMPV。
// 本次拆分保证模板产物与原 pet-chip.js **逐字节一致**(仅 bindName 改为模块内变量,求值结果不变),版本号不动。
const C = require('./config');
const { PETS } = C;
const { WEATHER } = require('./weather');   // 模板构建期嵌入当前天气文本
let bindName = '';            // 守护每次新建 CDP 会话会换绑定名(setBindName 同步进来)
function setBindName(n) { bindName = String(n || ''); }
// ---------- 状态→帧表(Petdex 官方数据) ----------
// 帧:[列, 持续ms]
const FRAMES = {
  idle:            { row: 0, f: [[0, 280], [1, 110], [2, 110], [3, 140], [4, 140], [5, 320]] },
  'running-right': { row: 1, f: [[0, 120], [1, 120], [2, 120], [3, 120], [4, 120], [5, 120], [6, 120], [7, 220]] },
  'running-left':  { row: 2, f: [[0, 120], [1, 120], [2, 120], [3, 120], [4, 120], [5, 120], [6, 120], [7, 220]] },
  waving:          { row: 3, f: [[0, 140], [1, 140], [2, 140], [3, 280]] },
  jumping:         { row: 4, f: [[0, 140], [1, 140], [2, 140], [3, 140], [4, 280]] },
  failed:          { row: 5, f: [[0, 140], [1, 140], [2, 140], [3, 140], [4, 140], [5, 140], [6, 140], [7, 240]] },
  waiting:         { row: 6, f: [[0, 150], [1, 150], [2, 150], [3, 150], [4, 150], [5, 260]] },
  running:         { row: 7, f: [[0, 120], [1, 120], [2, 120], [3, 120], [4, 120], [5, 220]] },
  review:          { row: 8, f: [[0, 150], [1, 150], [2, 150], [3, 150], [4, 150], [5, 280]] },
};
const PAGE_CSS =
  'position:fixed;z-index:2147483646;cursor:grab;user-select:none;' +
  'filter:drop-shadow(0 2px 4px rgba(0,0,0,.35));' +
  'image-rendering:pixelated;' +
  'transform-origin:50% 100%;transition:transform .12s ease;';

function bubbleHtml() {
  // 星露谷风格对话框(2026-10-02 用户要求):奶油纸底 + 深棕木框 + 小圆角 + 硬投影,字用深棕
  return `(function(){
  var b=document.createElement('div');
  b.style.cssText='position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:8px;'+
    'background:#f7e2b8;color:#4a3117;max-width:300px;'+
    'font:600 12px/1.6 Consolas,ui-monospace,monospace;padding:7px 9px;gap:.35em;align-items:center;flex-wrap:wrap;justify-content:center;'+
    'border:3px solid #6b4423;border-radius:6px;'+
    'box-shadow:inset 0 0 0 2px #fdf3d9,inset 0 0 0 3px #d8b478,4px 4px 0 0 rgba(40,24,8,.45);'+
    'display:none;text-align:center;image-rendering:pixelated;';
  var tail=document.createElement('div');
  tail.style.cssText='position:absolute;bottom:-7px;left:50%;transform:translateX(-50%) rotate(45deg);'+
    'width:11px;height:11px;background:#f7e2b8;'+
    'border-right:3px solid #6b4423;border-bottom:3px solid #6b4423;';
  b.appendChild(tail);b._tail=tail;
  b._ov=document.createElement('div');
  b._ov.style.cssText='display:none;color:#96500f;text-shadow:0 1px 0 #fdf3d9;';
  b.appendChild(b._ov);
  b._p1=document.createElement('span');b._p2=document.createElement('span');b._p3=document.createElement('span');
  [b._p1,b._p2,b._p3].forEach(function(sl){
    sl.style.cssText='display:none;padding:.18em .6em;border-radius:4px;border:2px solid transparent;white-space:nowrap;';
    b.appendChild(sl);
  });
  // 状态行:上文字(等级+称号+饱食度%)下通条(等级进度),两行互不挤压
  var satRow=document.createElement('div');
  satRow.style.cssText='display:none;flex:1 1 100%;flex-direction:column;align-items:stretch;gap:3px;margin-top:4px;';
  var satLbl=document.createElement('span');
  satLbl.style.cssText='font-size:10px;color:#3f6b2f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  var satBarRow=document.createElement('div');
  satBarRow.style.cssText='display:flex;align-items:center;gap:4px;';
  var satBar=document.createElement('div');
  satBar.style.cssText='flex:1 1 auto;height:9px;background:#c9ac74;border:2px solid #8a6234;border-radius:4px;overflow:hidden;';
  var satFill=document.createElement('div');
  satFill.style.cssText='height:100%;width:0%;background:repeating-linear-gradient(90deg,#8fbf5f 0 6px,#6fa348 6px 9px);';
  var satCap=document.createElement('span');
  satCap.style.cssText='font-size:9px;color:#8a5a12;white-space:nowrap;';
  satBar.appendChild(satFill);
  satBarRow.appendChild(satBar);satBarRow.appendChild(satCap);
  // 当前模型(大名,如 DeepSeek / GLM(订阅));订阅套餐没有单价,只报名字
  var mdl=document.createElement('div');
  mdl.style.cssText='display:none;font-size:9px;color:#7a5a2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  // 实时工作框(内容由外层 IIFE 的 renderWork 按"几个会话在跑"动态生成,一段一行、段间虚线)
  var wk=document.createElement('div');
  wk.style.cssText='display:none;width:100%;flex-direction:column;align-items:stretch;gap:0;margin-bottom:3px;';
  satRow.appendChild(satLbl);satRow.appendChild(satBarRow);satRow.appendChild(mdl);
  b.appendChild(satRow);
  b.insertBefore(wk,satRow);   // 工作框排在饱食度行上面(satRow 必须先挂进 b,insertBefore 才合法)
  b._work=wk;wk._key='';wk._rows=[];
  b._satRow=satRow;b._satLbl=satLbl;b._satBar=satBar;b._satFill=satFill;b._satCap=satCap;b._mdl=mdl;
  // 番茄钟胶囊(第 4 枚)
  b._p4=document.createElement('span');
  b._p4.style.cssText='display:none;padding:.18em .6em;border-radius:4px;border:2px solid #c08a3e;color:#8a4a12;background:#f3e3bc;white-space:nowrap;';
  b.appendChild(b._p4);
  return b;
})()`;
}

function petJs(state, badges, balLine, lowBal, ovr, ext) {
  return `(function(){
// 隐藏守卫:菜单里选了「隐藏」就撤掉元素,并且这一整个页面会话都不再重建它。
// 页面重载(= 重启 ZCode / 重开窗口)后 window 清空,宠物自己回来 —— 这才是菜单承诺的"重启后恢复"。
if(window.__tokPetHidden){var _hd=document.getElementById('tok-pet');if(_hd)_hd.remove();return;}
var S=${JSON.stringify(state)};
var BADGES=${JSON.stringify(badges)};
var BALLINE=${JSON.stringify(balLine)};
var LOW=${JSON.stringify(lowBal)};
var OVR=${JSON.stringify(ovr)};
var EXT=${JSON.stringify(ext)};
var PACK=EXT.pack||{};
var BIND=${JSON.stringify(typeof bindName==='string'?bindName:'')};
var SAT=EXT.sat||{pct:80,lv:1,title:''}, ACH=EXT.ach||{list:[],got:0,total:0}, POM=EXT.pom||null, NIGHT=EXT.night||0, FEEDTICK=(typeof EXT.feedTick==='number')?EXT.feedTick:0, CHECKIN=EXT.checkin||{done:0,streak:0};
// 页面→守护请求:优先 CDP Binding 推送,localStorage 兜底(守护按时间戳去重)
// 绑定名必须每次调用时从 window.__tokPetBind 现取,不能用本函数所在闭包里的 BIND:
// 菜单是「MENUV 变了才重建」的常驻闭包(见下面 window.__tokPetMenuV 判断),而守护每次重启
// 都会注册新的绑定名 ⇒ 旧闭包里烘焙的 BIND 会指向一个已经死掉的注册,请求静默丢失。
function emitReq(k,v){try{var nb=window.__tokPetBind||BIND;var f=nb&&window[nb];if(typeof f==='function')f(k+'|'+v)}catch(_){ }
  // localStorage 兜底通道:必须写守护 fastPoll 真正读的键名(曾写成裸 k,导致菜单里的喂食/签到/番茄钟全部失效)
  try{var KEY={bal:'tokPetBalReq',click:'tokPetClickReq',feed:'tokPetFeedReq',checkin:'tokPetCheckinReq',pom:'tokPetPomReq',egg:'tokPetEggReq',slug:'tokPetSlug',apiadd:'tokPetApiAddReq',apidel:'tokPetApiDelReq'}[k]||k;localStorage.setItem(KEY,v)}catch(_){ }}
// 本地点击回应:内容随注入下发,立刻显示,不等守护往返
function localClick(){
  var now0=Date.now(),txt=null;
  if((PACK.hungry&&PACK.hungry.length)&&(window.__tokPetSatPct!=null&&window.__tokPetSatPct<15)&&Math.random()<0.5){txt=PACK.hungry[Math.floor(Math.random()*PACK.hungry.length)];}
  else{var r=Math.random();
    if(r<0.15&&PACK.wx)txt=PACK.wx;
    else if(r<0.55&&PACK.hit)txt='「'+PACK.hit.t+'」'+(PACK.hit.f?' —— '+PACK.hit.f:'');
    else if(r<0.85&&PACK.dev&&PACK.dev.length)txt=PACK.dev[Math.floor(Math.random()*PACK.dev.length)];
    else if(PACK.greet)txt=PACK.greet+(PACK.sum?' · 本会话已 '+PACK.sum:'')+(PACK.checkin?'':' · 记得签到哦');
  }
  if(txt){var bb=document.getElementById('tok-pet');if(bb)bb._instant={text:txt,until:now0+4200,at:now0};}
  try{localStorage.setItem('tokPetClickReq',String(now0))}catch(_){ }
  window.__tokPetLastClick=now0;
}
// 喂食掉落动画:食物从头顶落到嘴边(一次 2-4 颗、随缩放放大、末尾弹一下)
function dropFood(dd){
  if(!dd||!dd.isConnected)return;
  var now1=Date.now(),alive=0;
  for(var c0=0;c0<dd.children.length;c0++){
    var cc=dd.children[c0];
    if(!cc._isFood)continue;
    if(cc._until>now1)alive++;                       // 顺手清理过期残留(动画没清掉的也不占名额)
    else{try{cc.remove()}catch(_){}}
  }
  if(alive>=8)return;                                // 太多了就跳过,别糊成一片(直接数 DOM,计数器会漏)
  var sc=parseFloat(dd.dataset.s)||0.55;
  var base=Math.round(26*(sc/0.55));                 // 原来固定 14px 太小看不见;26 基准约等于宠物宽度的四分之一
  var h=dd.offsetHeight||156;
  var n=2+Math.floor(Math.random()*3);               // 一次掉 2-4 颗,错开时间,像"投喂"
  for(var i=0;i<n;i++){
    (function(i){
      setTimeout(function(){
        if(!dd.isConnected)return;
        var f=document.createElement('div');
        var food=['🍖','🍙','🍗','🍕'][Math.floor(Math.random()*4)];
        f.textContent=food;
        var fs=Math.round(base*(0.85+Math.random()*0.45));
        var fall=h*(0.42+Math.random()*0.12);        // 落到宠物嘴边/胸口
        var rot=(-14+Math.random()*28).toFixed(0);
        var dur=1000+Math.floor(Math.random()*300);
        // opacity:0 是兜底基线:万一动画没跑完就消失,残留的那颗也不会卡在头顶上(关键帧里都写了 opacity,运行期间不受影响)
        f.style.cssText='position:absolute;left:'+(10+Math.random()*52)+'%;top:-'+(base*0.7|0)+'px;'+
          'font-size:'+fs+'px;line-height:1;opacity:0;z-index:2;pointer-events:none;will-change:transform,opacity;';
        f._isFood=1;f._until=Date.now()+dur+400;
        dd.appendChild(f);
        var kill=function(){try{f.remove()}catch(_){}};
        try{
          f.animate([
            {transform:'translateY(0) rotate('+rot+'deg) scale(.55)',opacity:0},
            {transform:'translateY('+(fall*0.3).toFixed(0)+'px) rotate(0deg) scale(1)',opacity:1,offset:.22},
            {transform:'translateY('+fall.toFixed(0)+'px) rotate(0deg) scale(1)',opacity:1,offset:.7},
            {transform:'translateY('+(fall*0.84).toFixed(0)+'px) rotate(0deg) scale(1.15)',opacity:1,offset:.85},
            {transform:'translateY('+(fall*0.9).toFixed(0)+'px) rotate(0deg) scale(.8)',opacity:0}
          ],{duration:dur,easing:'steps(9)'}).onfinish=kill;
        }catch(_){kill()}
        // onfinish 实测会漏(动画跑完却不派发,残留一颗卡在头顶),定时器兜底清场
        setTimeout(kill,dur+250);
      },i*110);
    })(i);
  }
}
// 走路(散步/回家)结束时,把动画交还给"当前状态"。
// 以前只有守护每一拍注入时才会顺手还原动画(见文件末尾的 __tokPetSet(S)),于是守护一死、
// 或者刚好卡在最长 5 秒的注入节流窗口里,宠物就永久定格在走路那一行、原地踏到天荒地老
//(用户报的"散步回到原点后一直保持走路动画")。
function restoreAnim(dd){
  if(!dd||!window.__tokPetSet)return;
  if(dd._drag||dd._ovl>Date.now())return;   // 拖拽中 / 摸头跳跃等临时动作期间不抢
  window.__tokPetSet(dd._state||'idle');
}
// 实时工作框:守护每拍下发 EXT.work = {items:[{k,n,l2,l3}], more, multi}
// 一个会话在跑时跟以前一样(阶段行 + 详情行);多个会话同时在跑时,每段上面加一行小字会话名、
// 段与段之间画一条虚线,谁完工谁那一段自己消失(段数变了页面就重建一次)。
// 只在"段的集合"真的变了才重建 DOM —— 每秒重建会闪一下;同一批会话只是文字在变就只改 textContent。
function renderWork(b,WK){
  var wk=b._work;if(!wk)return;
  var items=(WK&&WK.items)||[];
  var key=(WK.multi?'M':'S')+'|'+items.map(function(i){return i.k}).join(',')+'|'+(WK.more||0);
  if(wk._key!==key){
    wk._key=key;wk.textContent='';wk._rows=[];
    for(var i=0;i<items.length;i++){
      if(i>0){var dv=document.createElement('div');dv.style.cssText='border-top:2px dashed #c09355;margin:3px 0 1px;';wk.appendChild(dv);}
      var box=document.createElement('div');
      box.style.cssText='display:flex;flex-direction:column;align-items:stretch;';
      var nm=null;
      if(WK.multi){
        nm=document.createElement('div');
        nm.style.cssText='font-size:10px;color:#8a5a12;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        box.appendChild(nm);
      }
      var l2=document.createElement('span');l2.style.cssText='font-size:14px;font-weight:700;color:#4a3117;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      var l3=document.createElement('span');l3.style.cssText='font-size:12px;color:#8a6a3e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      box.appendChild(l2);box.appendChild(l3);
      wk.appendChild(box);
      wk._rows.push({nm:nm,l2:l2,l3:l3});
    }
    if(WK.more>0){
      var mr=document.createElement('div');
      mr.style.cssText='font-size:10px;color:#8a5a12;margin-top:2px;padding-top:2px;border-top:2px dashed #c09355;';
      mr.textContent='…还有 '+WK.more+' 个会话在跑';
      wk.appendChild(mr);
    }
  }
  var rows=wk._rows||[];
  for(var j=0;j<items.length;j++){
    var r=rows[j];if(!r)continue;
    if(r.nm)r.nm.textContent=items[j].n||'';
    r.l2.textContent=items[j].l2||'';
    r.l3.textContent=items[j].l3||'';
  }
}
// 空闲散步:掷骰走一段就走完(回家的活交给回家看门狗 walkHome,见创建分支)
function startWalk(dd){
  if(dd._walking)return;
  var w=dd.offsetWidth||100;
  var cur0=parseFloat(dd.style.left);if(isNaN(cur0))return;
  var dir=Math.random()<0.5?-1:1;
  var target=Math.max(8,Math.min(cur0+dir*(60+Math.random()*180),innerWidth-w-8));
  if(Math.abs(target-cur0)<30)return;
  dd._walking=true;
  if(window.__tokPetSet)window.__tokPetSet(dir>0?'running-right':'running-left');
  (function stepWalk(){
    if(!dd._walking||!dd.isConnected||dd._drag){dd._walking=false;return;}
    var c2=parseFloat(dd.style.left);
    var dl=target-c2;
    if(Math.abs(dl)<3){dd._walking=false;restoreAnim(dd);return;}
    dd.style.left=(c2+(dl>0?2:-2))+'px';
    setTimeout(stepWalk,24);
  })();
}
var CLS={turn:{c:"#8a5a12",b:"#c08a3e",g:"#f3e3bc"},sum:{c:"#1f6076",b:"#7fa8b8",g:"#e4eef0"},"bal-ok":{c:"#2f6b32",b:"#8fb87a",g:"#e8f0d8"},"bal-low":{c:"#a33b2a",b:"#d09a86",g:"#f6e0d6"}};
var FR=${FRAMES_JSON};
var PETS=${PETS_JSON};
var SLUG=null;try{SLUG=localStorage.getItem('tokPetSlug')}catch(_){ }
var PET=PETS.find(function(p){return p.slug===SLUG})||PETS[0];
var VER='57';   // 页面模板版本:改了页面代码必须 +1。守卫与创建共用同一常量,避免两边写岔(曾因此不重建)
var d=document.getElementById('tok-pet');
if(d&&d.dataset.v!==VER){d.remove();d=null;}
if(!d){
  d=document.createElement('div');d.id='tok-pet';d.dataset.v=VER;
  var S0=0.55;try{S0=parseFloat(localStorage.getItem('tokPetScale'))||0.55}catch(_){ }
  d.dataset.s=String(S0);
  d.style.cssText=${PAGE_CSS_JSON}+'width:'+(192*S0)+'px;height:'+(208*S0)+'px;'+
    'background-image:url('+PET.sprite+');background-repeat:no-repeat;'+
    'background-size:'+(8*192*S0)+'px '+(PET.rows*208*S0)+'px;';
  var pos=null;try{pos=JSON.parse(localStorage.getItem('tokPetPos'))}catch(_){ }
  if(pos){d.style.left=pos.x+'px';d.style.top=pos.y+'px';}else{d.style.right='18px';d.style.bottom='96px';}
  clampPet();
  var b=${bubbleHtml()};
  d.appendChild(b);d._bubble=b;
  (document.body||document.documentElement).appendChild(d);
  // 家的锚点:必须在 appendChild 之后取 rect(游离元素 rect 恒为 0,曾把锚点变成左边缘、宠物被看门狗拽走)
  d._homeX=(function(){var r=d.getBoundingClientRect();return isFinite(r.left)?r.left:null;})();
  // 拖拽:左右方向跑步;位移过小视为点击(摸头跳跃)
  var dragMoved=false;
  d.addEventListener('mousedown',function(ev){
    if(ev.button!==0)return;ev.preventDefault();
    var sx=ev.clientX,sy=ev.clientY,r=d.getBoundingClientRect(),ox=r.left,oy=r.top;
    dragMoved=false;d._drag=true;var dir=0;
    d.style.cursor='grabbing';d.style.transform='scale(0.94)';
    function mv(e){
      var dx=e.clientX-sx;
      if(Math.abs(dx)>6||Math.abs(e.clientY-sy)>6)dragMoved=true;
      if(dragMoved){
        d.style.left=(ox+e.clientX-sx)+'px';d.style.top=(oy+e.clientY-sy)+'px';
        d.style.right='auto';d.style.bottom='auto';
        clampPet();
        var nd=dx>2?1:(dx<-2?-1:dir);
        if(nd!==dir&&window.__tokPetSet){dir=nd;window.__tokPetSet(nd>0?'running-right':'running-left');}
      }
    }
    function up(){
      document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
      d.style.cursor='grab';d._drag=false;clampPet();
      d.style.transform='scale(1.05)';setTimeout(function(){d.style.transform='scale(1)'},130);
      if(!dragMoved){
        var now2=Date.now();
        window.__tokClicks=(window.__tokClicks||[]).filter(function(t){return now2-t<2500});
        window.__tokClicks.push(now2);
        var showOv=function(t){d._bubble._ov.textContent=t;d._bubble._ov.style.display='block';[d._bubble._p1,d._bubble._p2,d._bubble._p3].forEach(function(sl){sl.style.display='none'});};
        if(window.__tokClicks.length>=4){
          d._ovl=now2+2000;window.__tokPetSet('jumping');
          d._instant={text:'别戳啦,晕了晕了(>_<)',until:now2+2500,pri:'egg'};showOv(d._instant.text);
          emitReq('egg',String(now2)) // 上报戳晕(成就用)
        } else {
          localClick()
          d._ovl=now2+2000;window.__tokPetSet('waving');
          window.__tokClickAt=now2;window.__tokGotOvrAt=0;
          var T='好耶,被摸头了~|毛顺了,心情 +1|再摸要掉毛啦|咕噜咕噜(舒适)|今天也很努力哦|摸鱼成功 +1'.split('|');
          setTimeout(function(){
            if(window.__tokGotOvrAt<now2){d._instant={text:T[Math.floor(Math.random()*T.length)],until:now2+4500};}
          },1400);
        }
      }
      var rc=d.getBoundingClientRect();
      d._homeX=rc.left;   // 拖到哪,哪就是新家
      try{localStorage.setItem('tokPetPos',JSON.stringify({x:Math.round(rc.left),y:Math.round(rc.top)}))}catch(_){ }
    }
    document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
  });
  // 帧动画循环
  var cur='idle',fi=0;
  window.__tokPetSet=function(s){
    if(!FR[s])return;
    if(s!==cur){cur=s;fi=0;}
  };
  (function step(){
    if(!d.isConnected)return;
    var def=FR[cur]||FR.idle;
    var f=def.f[fi%def.f.length];
    var ss=parseFloat(d.dataset.s)||0.55; // 每帧实时取缩放,调大小后帧位不漂移
    d.style.backgroundPosition=(-f[0]*192*ss)+'px '+(-def.row*208*ss)+'px';
    fi++;setTimeout(step,f[1]);
  })();
  // 深夜 Zzz 泡泡
  var z=document.createElement('div');z.textContent='💤';
  z.style.cssText='position:absolute;top:-16px;right:2px;font-size:13px;display:none;z-index:2;pointer-events:none;';
  d.appendChild(z);d._zzz=z;
  try{z.animate([{opacity:.35,transform:'translateY(0)'},{opacity:1,transform:'translateY(-3px)'}],{duration:1500,iterations:Infinity});}catch(_){ }
  // 喂食掉落动画(像素食物落头顶)
  window.__tokPetDrop=dropFood;
  window.__tokPetWalk=startWalk;
  // 空闲散步:每 20-45s 掷骰,自己溜达一段(夜间/拖拽/隐藏时不走)
  (function walkLoop(){
    setTimeout(function(){
      try{
        if(d._state==='idle'&&!d._night&&!d._drag&&d.isConnected&&d.style.display!=='none'&&document.visibilityState!=='hidden'&&Math.random()<0.6)startWalk(d);
      }catch(_){ }
      walkLoop();
    },20000+Math.random()*25000);
  })();
  // 回家看门狗:每 5 秒检查,离「家」(锚点=默认位置/最近一次拖拽落点)超过 40px 就自己走回去。
  // 干活(state=running)也回;只有被拖拽中、睡觉、窗口隐藏时不走。锚点在拖拽结束处更新。
  var walkHome=function(){
    try{
      if(!d.isConnected||d._walking||d._drag||d._night||d._homeX==null)return;
      if(document.visibilityState==='hidden')return;
      var c=parseFloat(d.style.left);
      if(!isFinite(c))return;
      var w2=d.offsetWidth||105;
      var tx=Math.max(8,Math.min(d._homeX,innerWidth-w2-8));   // 锚点可能因窗口缩放跑到视口外,夹回来
      // 到家判定必须比"夹过的目标 tx",不能比原始 _homeX:锚点一旦落在夹取范围外(窗口变窄/改过缩放),
      // |c-_homeX| 永远 >40 ⇒ 每 5 秒重放一次走路动画;而 tx===c 时方向恒取"往左",看着就是原地踏步。
      if(Math.abs(c-tx)<=40){
        if(tx!==d._homeX)d._homeX=tx;   // 锚点收敛到真正能落脚的地方,以后不再白走这一趟
        return;
      }
      d._walking=true;
      if(window.__tokPetSet)window.__tokPetSet(tx>c?'running-right':'running-left');
      (function st(){
        if(!d.isConnected||!d._walking||d._drag||d._night){d._walking=false;restoreAnim(d);return;}
        var c2=parseFloat(d.style.left);
        var dl=tx-c2;
        if(Math.abs(dl)<3){d._walking=false;d._homeX=tx;restoreAnim(d);return;}
        d.style.left=(c2+(dl>0?2:-2))+'px';
        setTimeout(st,24);
      })();
    }catch(_){ }
  };
  setInterval(walkHome,5000);
}else{
  var sv2=null;try{sv2=parseFloat(localStorage.getItem('tokPetScale'))}catch(_){ }
  if(sv2){d.dataset.s=String(sv2);d.style.width=(192*sv2)+'px';d.style.height=(208*sv2)+'px';d.style.backgroundSize=(8*192*sv2)+'px '+(PET.rows*208*sv2)+'px';}
}
function clampPet(){
  if(!d)return;
  // 尺寸兜底按当前缩放算:旧写死 105/114,宠物调大时夹不准(残留位置可从屏幕外侧"合法"地留着)
  var s0=parseFloat(d.dataset.s);if(!isFinite(s0)||s0<=0)s0=0.55;
  var w=d.offsetWidth||Math.round(192*s0),h=d.offsetHeight||Math.round(208*s0);
  var l=parseFloat(d.style.left),t=parseFloat(d.style.top);
  if(isNaN(l)||isNaN(t))return;
  var nl=Math.max(0,Math.min(l,innerWidth-w));
  var nt=Math.max(0,Math.min(t,innerHeight-h));
  if(nl!==l)d.style.left=nl+'px';
  if(nt!==t)d.style.top=nt+'px';
}
// 自愈(2026-10-05 用户报"工作框还是被截"):宠物本体一旦整个跑到视口之外(只剩气泡吊在屏幕顶边,
// 看着就像被顶部那条带截掉了首行),或者尺寸塌成 0,没有任何循环会把它救回来 —— clampPet 只在创建/拖拽当时跑。
// 这里每 300ms 兜一次:位置优先按 inline 值(不含拖拽 transform,免得和拖拽互抢),inline 值缺失才用 rect;
// 尺寸塌了按 dataset.s 补回来(素材没加载/缩放值坏掉时靠这个复活)。
function healPet(dd){
  if(!dd||dd._drag)return;
  var s=parseFloat(dd.dataset.s);if(!isFinite(s)||s<=0)s=0.55;
  var w=Math.round(192*s),h=Math.round(208*s);
  var r=dd.getBoundingClientRect();
  if(r.width<20||r.height<20){
    dd.style.width=w+'px';dd.style.height=h+'px';
    dd.style.backgroundSize=(8*192*s)+'px '+(PET.rows*208*s)+'px';
    r=dd.getBoundingClientRect();
  }
  var sl=parseFloat(dd.style.left),st=parseFloat(dd.style.top);
  var curL=isFinite(sl)?sl:r.left,curT=isFinite(st)?st:r.top;
  var nl=Math.max(0,Math.min(curL,innerWidth-w)),nt=Math.max(0,Math.min(curT,innerHeight-h));
  if(Math.abs(nl-curL)>1||Math.abs(nt-curT)>1){
    dd.style.left=nl.toFixed(1)+'px';dd.style.top=nt.toFixed(1)+'px';dd.style.right='auto';dd.style.bottom='auto';
  }
}
// 右键菜单:全局注册一次,版本号守卫(菜单定义不随元素重建)
// ⚠ 守卫与赋值必须用同一个常量 MENUV:以前两处各写一个数字,只改一处就会出现
//   "守卫永远不成立 → 每一拍都重新注册一遍菜单"的静默泄漏(每次注册都往 document 多加一个 contextmenu 监听)
var MENUV='33';
window.__tokPetBalLine=BALLINE;
if(window.__tokPetMenuV!==MENUV){
  window.__tokPetMenuV=MENUV;
  window.__tokPetMenu=function(ev){
    var d=document.getElementById('tok-pet');
    if(!d||d.style.display==='none')return;
    var old=document.getElementById('tok-pet-menu');if(old)old.remove();
    var m=document.createElement('div');m.id='tok-pet-menu';
    m.style.cssText='position:fixed;z-index:2147483647;min-width:130px;padding:5px;'+
      'background:#f7e2b8;border:3px solid #6b4423;border-radius:6px;'+
      'box-shadow:inset 0 0 0 2px #fdf3d9,4px 4px 0 0 rgba(40,24,8,.45);font:600 12px/1.6 Consolas,ui-monospace,monospace;color:#4a3117;';
    function item(l,fn,dim){var i=document.createElement('div');i.textContent=l;
      i.style.cssText='padding:4px 10px;border-radius:4px;cursor:default;white-space:nowrap;'+(dim?'opacity:.5;':'');
      i.addEventListener('mouseenter',function(){i.style.background='#efd4a0'});
      i.addEventListener('mouseleave',function(){i.style.background='none'});
      i.addEventListener('click',function(){m.remove();if(!dim)fn()});m.appendChild(i);}
    // 二级菜单:父项点了不关菜单,悬停/点击在它旁边展开子项(宠物多了以后不用轮换)
    function itemSub(l,build){
      var i=document.createElement('div');i.textContent=l+' ▸';
      i.style.cssText='padding:4px 10px;border-radius:4px;cursor:default;white-space:nowrap;';
      i.addEventListener('mouseenter',function(){i.style.background='#efd4a0';open();});
      i.addEventListener('mouseleave',function(){i.style.background='none';});
      i.addEventListener('click',function(e2){e2.stopPropagation();open();});
      function open(){
        var old=document.getElementById('tok-pet-sub');if(old)old.remove();
        var sub=document.createElement('div');sub.id='tok-pet-sub';
        sub.style.cssText='position:fixed;z-index:2147483647;min-width:120px;padding:5px;'+
          'background:#f7e2b8;border:3px solid #6b4423;border-radius:6px;box-shadow:inset 0 0 0 2px #fdf3d9,4px 4px 0 0 rgba(40,24,8,.45);'+
          'font:600 12px/1.6 Consolas,ui-monospace,monospace;color:#4a3117;';
        build(sub,function(){m.remove()});
        // 必须挂在菜单里:外部 mousedown 的 m.contains(target) 判定才不会把子菜单当"外面"直接关掉
        m.appendChild(sub);
        var ir=i.getBoundingClientRect(),sr=sub.getBoundingClientRect();
        var left=ir.left-sr.width-10;
        if(left<6)left=Math.min(innerWidth-sr.width-6,ir.right+6);
        sub.style.left=Math.max(6,left)+'px';
        sub.style.top=Math.max(6,Math.min(ir.top,innerHeight-sr.height-8))+'px';
      }
      m.appendChild(i);
    }
    var scales=[0.4,0.55,0.75,1.0];
    var curS=parseFloat(d.dataset.s||'0.55');if(scales.indexOf(curS)<0)curS=0.55;
    var BL=window.__tokPetBalLine;
    var MD=window.__tokPetModel||{};
    // 多会话并行时,前 three 项(当前模型/余额/本会话拆账)各变一个二级菜单,每个在跑的会话一行;
    // 单会话时维持老样子。● 标记统计气泡当前跟的那只。行都只是显示,点了不动作(余额菜单里的刷新行除外)
    var BUSY=(MD.busy||[]).filter(function(x){return x&&x.n;});
    var MULTI=BUSY.length>1;
    var mdlTxt='🤖 当前模型:'+(MD.cur||'未知')+(MD.sub?' · 订阅':(MD.billed?' · API 按量':' · API 未配价'));
    var balTxt='💰 '+(BL||'余额:使用 API 后显示');
    var PROV=window.__tokPetProv||'';
    // 子菜单通用行:只显示
    function subRow(sub,txt,dim,title,onClick){
      var e=document.createElement('div');
      e.textContent=txt;
      if(title)e.title=title;
      e.style.cssText='padding:4px 10px;border-radius:4px;cursor:default;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis;'+(dim?'opacity:.6;':'');
      e.addEventListener('mouseenter',function(){e.style.background='#efd4a0'});
      e.addEventListener('mouseleave',function(){e.style.background='none'});
      if(onClick)e.addEventListener('click',function(e2){e2.stopPropagation();m.remove();onClick();});
      sub.appendChild(e);
    }
    if(!MULTI){
      item(mdlTxt,function(){},true);
      item(balTxt,function(){
        emitReq('bal',String(Date.now()))
      });
      if(PROV)item('💸 本会话 '+PROV,function(){},true);
    }else{
      itemSub(mdlTxt,function(sub){
        BUSY.forEach(function(b){
          subRow(sub,(b.cur?'● ':'\u3000')+b.n+' · '+(b.mdl||'模型识别中')+(b.sub?' · 订阅':(b.billed?' · API 按量':' · API 未配价')),!!b.cur);
        });
      });
      itemSub(balTxt,function(sub){
        subRow(sub,'↻ 刷新余额(当前那只)',false,'重新查一遍各家的余额/额度',function(){
          emitReq('bal',String(Date.now()));
        });
        BUSY.forEach(function(b){
          subRow(sub,(b.cur?'● ':'\u3000')+b.n+' · '+(b.bal||'—'),!!b.cur,b.bal?'':'这家的余额还没查到(有 key 会自动补查;没配 key 就显示不了)');
        });
      });
      var anyProv=false;
      for(var bi=0;bi<BUSY.length;bi++)if(BUSY[bi].prov)anyProv=true;
      if(PROV||anyProv){
        itemSub(PROV?('💸 本会话 '+PROV):'💸 本会话(各会话拆账)',function(sub){
          BUSY.forEach(function(b){
            subRow(sub,(b.cur?'● ':'\u3000')+b.n+' · '+(b.prov||'还没花钱'),!!b.cur);
          });
        });
      }
    }
    // 各会话用量 + 最近三轮,合并在一个面板里(以前是"各会话用量"二级菜单 + "最近三轮"面板两处,
    // 菜单太长;现在一个会话一段:标题(带 ✕ 隐藏)+ Σ/本轮用量 + 该会话最近 3 轮)。
    // 数据由守护每 10 秒从 ZCode 的用量库(db.sqlite)取一次、随这一拍 payload 一起下来。
    // ● = 统计气泡当前跟的那个会话;"在跑" = 这一刻它的回合还开着。
    var REC=MD.recent||null;
    item('📊 各会话用量与最近三轮'+(REC?('('+REC.items.length+' 个会话)'):''),function(){
      var had=document.getElementById('tok-pet-recent');if(had)had.remove();
      var rp=document.createElement('div');rp.id='tok-pet-recent';
      rp.style.cssText='position:fixed;z-index:2147483647;padding:8px 10px;background:#f7e2b8;border:3px solid #6b4423;border-radius:6px;box-shadow:inset 0 0 0 2px #fdf3d9,inset 0 0 0 3px #d8b478,4px 4px 0 0 rgba(40,24,8,.45);font:600 11px/1.9 Consolas,ui-monospace,monospace;color:#4a3117;width:360px;max-height:calc(100vh - 24px);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#b98a4e #efd6a8;';
      function line(ri,t){
        var e=document.createElement('div');e.style.cssText='display:flex;gap:6px;align-items:baseline;white-space:nowrap;';
        var a1=document.createElement('span');a1.textContent=NUM[ri]||'·';a1.style.cssText='flex:0 0 auto;opacity:.6;';
        var a2=document.createElement('span');a2.textContent=t.t;a2.style.cssText='flex:0 0 auto;color:#8a5a12;';
        var a3=document.createElement('span');a3.textContent=t.m;a3.style.cssText='flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;';
        var a4=document.createElement('span');a4.textContent=t.u+(t.c?' '+t.c:'');a4.style.cssText='flex:0 0 auto;color:#1f6076;';
        e.title='这一轮发了 '+t.q+' 次请求';
        e.appendChild(a1);e.appendChild(a2);e.appendChild(a3);e.appendChild(a4);
        return e;
      }
      function foot(){
        var f=document.createElement('div');
        f.style.cssText='margin-top:5px;padding-top:5px;border-top:2px dashed #c09355;';
        var e1=document.createElement('div');
        e1.textContent='一轮 = 该轮所有请求的 token 相加 · 费用按该轮最后用的模型算(订阅套餐不显费用)';
        e1.style.cssText='opacity:.6;white-space:normal;';f.appendChild(e1);
        var e2=document.createElement('div');
        e2.textContent='✕ = 不再显示这个会话的记录(不删 ZCode 的用量库,随时能恢复)';
        e2.style.cssText='opacity:.6;white-space:normal;';f.appendChild(e2);
        var nHid=hidN();
        if(nHid){
          var e3=document.createElement('div');
          e3.textContent='🙈 已隐藏 '+nHid+' 个会话 · 点这里全部恢复';
          e3.style.cssText='margin-top:3px;cursor:pointer;color:#a8451f;white-space:normal;';
          e3.addEventListener('mouseenter',function(){e3.style.background='#efd4a0'});
          e3.addEventListener('mouseleave',function(){e3.style.background='none'});
          e3.addEventListener('click',function(e){e.stopPropagation();emitReq('unhide','all');window.__tokPetHid={};close();});
          f.appendChild(e3);
        }
        // 会话多到面板比屏幕还高时,它自己在内部滚动(见 rp 的 overflow:auto),这里交代一句
        if(REC&&REC.total>6){
          var e4=document.createElement('div');
          e4.textContent='↕ 会话多的时候面板内可滚动'+(REC.capped?(' · 只列最近 '+REC.items.length+' 个'):'');
          e4.style.cssText='margin-top:3px;opacity:.6;white-space:normal;';
          f.appendChild(e4);
        }
        return f;
      }
      var NUM=['①','②','③','④','⑤','⑥'];
      // 这一刻隐藏了几个:守护记下的(上次面板打开之后藏的)+ 这次打开面板期间当场藏的
      function hidN(){return ((REC&&REC.hid)||0)+localHid;}
      function close(){
        rp.remove();
        document.removeEventListener('mousedown',cl,true);document.removeEventListener('keydown',ky,true);
      }
      var cl=function(e2){if(rp.contains(e2.target))return;close();};
      var ky=function(e2){if(e2.key==='Escape')close();};
      var localHid=0;
      var h0=document.createElement('div');   // 文案在 draw() 里写:当场藏掉一个会话,数量要跟着变
      h0.style.cssText='color:#96500f;margin-bottom:4px;';rp.appendChild(h0);
      var box=document.createElement('div');rp.appendChild(box);   // 可重画区:藏掉一个就当场把它那一段去掉
      function draw(){
        box.textContent='';
        var items=((REC&&REC.items)||[]).filter(function(it){
          return !it.hid && !(window.__tokPetHid||{})[it.sid];
        });
        h0.textContent='📊 各会话用量与最近三轮'+(items.length?(' · 共 '+items.length+' 个会话'):'')+(REC?(' · 更新于 '+REC.upd):'');
        if(!items.length){
          var em=document.createElement('div');
          em.textContent=REC?'这个列表里的会话都被你隐藏了(或都归档了)。':'没读到用量数据。守护读的是 ZCode 的 db.sqlite(MCP 进程用同一个库),库打不开或还没有任何回合记录时就是这样。';
          em.style.cssText='white-space:normal;opacity:.75;';box.appendChild(em);
        }
        items.forEach(function(it,ii){
          if(ii){var dv=document.createElement('div');dv.style.cssText='border-top:2px dashed #c09355;margin:5px 0 4px;';box.appendChild(dv);}
          var hd=document.createElement('div');hd.style.cssText='display:flex;gap:6px;align-items:baseline;';
          var hn=document.createElement('span');
          hn.textContent=(it.cur?'● ':'\u3000')+it.n+(it.busy?' · 在跑':'');
          hn.title=it.sid;
          hn.style.cssText='flex:1 1 auto;color:#96500f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'+(it.cur?'':'opacity:.85;');
          var hx=document.createElement('span');
          hx.textContent='✕';hx.title='不再显示这个会话的记录(不删用量数据,可恢复)';
          hx.style.cssText='flex:0 0 auto;cursor:pointer;color:#a8451f;padding:0 4px;border-radius:3px;';
          hx.addEventListener('mouseenter',function(){hx.style.background='#efd4a0'});
          hx.addEventListener('mouseleave',function(){hx.style.background='none'});
          hx.addEventListener('click',function(e2){
            e2.stopPropagation();
            emitReq('hide',it.sid);                     // 守护落盘到 hidden-sessions.json
            it.hid=1;localHid++;draw();                 // 当场把它那段去掉,不用等下一拍
          });
          hd.appendChild(hn);hd.appendChild(hx);box.appendChild(hd);
          if(it.usg){
            var lu=document.createElement('div');
            lu.textContent=it.usg;lu.style.cssText='color:#1f6076;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            lu.title='这个会话:本轮 · 累计';box.appendChild(lu);
          }
          if(it.prov&&it.prov!==it.usg){
            var lp=document.createElement('div');
            lp.textContent=it.prov;lp.style.cssText='opacity:.75;white-space:normal;word-break:break-all;';
            lp.title='累计费用按家拆账';box.appendChild(lp);
          }
          (it.rows||[]).forEach(function(r2,ri){box.appendChild(line(ri,r2));});
        });
        if(ft0)ft0.remove();
        ft0=foot();rp.appendChild(ft0);
      }
      var ft0=null;
      draw();
      document.body.appendChild(rp);
      var r4=rp.getBoundingClientRect();
      rp.style.left=Math.max(8,Math.min(ev.clientX,innerWidth-r4.width-8))+'px';
      rp.style.top=Math.max(8,Math.min(ev.clientY-r4.height-8,innerHeight-r4.height-8))+'px';
      setTimeout(function(){
        document.addEventListener('mousedown',cl,true);document.addEventListener('keydown',ky,true);
      },0);
    });
    var curSlug=d.dataset.slug||PETS[0].slug;
    var curPet=PETS.find(function(pp){return pp.slug===curSlug})||PETS[0];
    function switchTo(slug){
      var np=PETS.find(function(pp){return pp.slug===slug});if(!np)return;
      try{localStorage.setItem('tokPetSlug',slug)}catch(_){ }
      emitReq('slug',slug);
      d.dataset.slug=slug;
      var s0=parseFloat(d.dataset.s)||0.55;
      d.style.backgroundImage='url('+np.sprite+')';
      d.style.backgroundSize=(8*192*s0)+'px '+(np.rows*208*s0)+'px';
    }
    itemSub('🐾 切换宠物(当前:'+curPet.name+')',function(sub,done){
      PETS.forEach(function(pp){
        var isCur=pp.slug===curSlug;
        var e=document.createElement('div');
        e.textContent=(isCur?'✓ ':'\u3000')+pp.name;
        e.style.cssText='padding:4px 10px;border-radius:4px;cursor:default;white-space:nowrap;'+(isCur?'opacity:.7;':'');
        e.addEventListener('mouseenter',function(){e.style.background='#efd4a0'});
        e.addEventListener('mouseleave',function(){e.style.background='none'});
        e.addEventListener('click',function(e2){e2.stopPropagation();done();switchTo(pp.slug);});
        sub.appendChild(e);
      });
    });
    item('🍖 喂食(饱食 '+(window.__tokPetSatPct!=null?window.__tokPetSatPct+'%':'…')+')',function(){
      emitReq('feed',String(Date.now()))
    });
    var CI=window.__tokPetCheckin||{done:0,streak:0};
    item(CI.done?'📅 已签到(连签 '+CI.streak+' 天)':'📅 签到(连签 '+CI.streak+' 天)',function(){
      emitReq('checkin',String(Date.now()))
    },!!CI.done);
    item(window.__tokPetPomLeft?('🍅 取消番茄钟(剩 '+window.__tokPetPomLeft+' 分)'):'🍅 番茄钟 25 分钟',function(){
      emitReq('pom',String(Date.now()))
    });
    item('🏆 成就墙('+((window.__tokPetAch&&window.__tokPetAch.got)||0)+'/'+((window.__tokPetAch&&window.__tokPetAch.total)||8)+')',function(){
      var old=document.getElementById('tok-pet-ach');if(old){old.remove();return;}
      var A=window.__tokPetAch||{list:[],got:0,total:0};
      var p=document.createElement('div');p.id='tok-pet-ach';
      p.style.cssText='position:fixed;z-index:2147483647;padding:8px 10px;background:#f7e2b8;border:3px solid #6b4423;border-radius:6px;box-shadow:inset 0 0 0 2px #fdf3d9,4px 4px 0 0 rgba(40,24,8,.45);font:600 11px/1.9 Consolas,ui-monospace,monospace;color:#4a3117;max-width:280px;';
      var t=document.createElement('div');t.textContent='🏆 成就墙 '+A.got+'/'+A.total;t.style.cssText='margin-bottom:4px;color:#96500f;';p.appendChild(t);
      (A.list||[]).forEach(function(a){var rr=document.createElement('div');rr.textContent=(a.got?'✅ ':'🔒 ')+a.name+' — '+a.desc;rr.style.cssText='white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'+(a.got?'':'opacity:.5;');p.appendChild(rr);});
      document.body.appendChild(p);
      var pr2=p.getBoundingClientRect();
      p.style.left=Math.min(ev.clientX,innerWidth-pr2.width-8)+'px';
      p.style.top=Math.max(8,Math.min(ev.clientY-pr2.height-8,innerHeight-pr2.height-8))+'px';
      setTimeout(function(){var h=function(e2){if(p.contains(e2.target))return;p.remove();document.removeEventListener('mousedown',h);};document.addEventListener('mousedown',h);var h2=function(e2){if(e2.key==='Escape'){p.remove();document.removeEventListener('keydown',h2);}};document.addEventListener('keydown',h2);},0);
    });
    item('➕ 添加 API(多模型计价/余额)',function(){
      var old2=document.getElementById('tok-pet-api');if(old2){old2.remove();return;}
      var p=document.createElement('div');p.id='tok-pet-api';
      p.style.cssText='position:fixed;z-index:2147483647;padding:8px 10px;background:#f7e2b8;border:3px solid #6b4423;border-radius:6px;box-shadow:inset 0 0 0 2px #fdf3d9,4px 4px 0 0 rgba(40,24,8,.45);font:600 11px/1.7 Consolas,ui-monospace,monospace;color:#4a3117;width:306px;max-height:calc(100vh - 24px);overflow:auto;';
      function line(t,cls){var x=document.createElement('div');x.textContent=t;x.style.cssText='white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'+(cls||'');p.appendChild(x);return x;}
      var inp={};
      function field(ph,key,txt,val){var r=document.createElement('div');r.style.cssText='display:flex;gap:6px;align-items:center;';
        var l=document.createElement('span');l.textContent=txt;l.style.cssText='width:38px;flex:0 0 auto;opacity:.7;';
        var i=document.createElement('input');i.placeholder=ph;i.value=val||'';
        i.style.cssText='flex:1 1 auto;min-width:0;background:#fdf3d9;color:#4a3117;border:2px solid #c09355;border-radius:3px;font:600 11px/1.5 Consolas,ui-monospace,monospace;padding:1px 4px;';
        r.appendChild(l);r.appendChild(i);p.appendChild(r);inp[key]=i;return i;}
      line('🤖 当前:'+(MD.cur||'未知')+(MD.sub?'(订阅套餐,不计费)':(MD.billed?'(按量计费)':'(没配单价,不显费用)')),'color:#96500f;margin-bottom:2px;');
      var lp=(MD.list||[]);
      if(lp.length){line('已添加:','opacity:.7;');
        lp.forEach(function(dd){
          var row=document.createElement('div');row.style.cssText='display:flex;align-items:center;gap:6px;';
          var t=document.createElement('span');t.textContent='· '+dd.label+'('+dd.match+')'+(dd.key||dd.zcode?' 有key':' 无key')+(dd.url?' 余额✓':'');
          t.style.cssText='flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          var del=document.createElement('span');del.textContent='🗑';del.title='删除';del.style.cssText='cursor:pointer;padding:0 4px;';
          del.addEventListener('click',function(){emitReq('apidel',dd.label);p.remove();});
          row.appendChild(t);row.appendChild(del);p.appendChild(row);
        });
      } else line('还没有自定义 API','opacity:.6;');
      if((MD.auto||[]).length)line('ZCode 里已有 key:'+MD.auto.join(', '),'opacity:.75;color:#1f6076;');
      var hint=null;
      // 「匹配」不用自己找:把脚本在用量库里见过的 provider_id 全列出来,点一下连余额/单价一起填好
      var seen=(MD.seen||[]);
      if(seen.length){
        line('见过的 provider(点一下自动填):','margin-top:4px;opacity:.7;');
        seen.forEach(function(sp){
          var row=document.createElement('div');row.style.cssText='display:flex;align-items:center;gap:6px;cursor:pointer;padding:0 2px;';
          row.title='provider_id = '+sp.p+' · model_id = '+sp.m+(sp.zcode?' · ZCode 里已配 key':'');
          var t=document.createElement('span');
          t.textContent='· '+sp.p+(sp.n?' '+sp.n+'次':'')+(sp.zcode?' ✓key':'')
            +(sp.quota?(sp.zcode?' 额度✓':' 额度(缺key)'):(sp.url?' 余额✓':(sp.nb?' 无接口':'')))+((sp.p===MD.pid)?' ← 现在用的':'');
          t.style.cssText='flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'+((sp.p===MD.pid)?'color:#96500f;':'');
          var use=document.createElement('span');use.textContent='用它';use.style.cssText='flex:0 0 auto;padding:0 6px;border:2px solid #c09355;border-radius:3px;background:#fdf3d9;';
          row.appendChild(t);row.appendChild(use);
          row.addEventListener('click',function(){
            inp.match.value=sp.p;
            if(sp.label)inp.label.value=sp.label;
            if(sp.url)inp.url.value=sp.url;
            if(sp.path)inp.path.value=sp.path;
            inp.hit.value=sp.hit||'';inp.miss.value=sp.miss||'';inp.out.value=sp.out||'';
            if(hint){
              if(sp.quota){hint.textContent='已按 '+sp.p+' 填好 —— 这家有订阅额度接口,key 通了就自动显示「已用%」,充值余额得自己填地址';hint.style.color='#1f6076';}
              else if(sp.hit||sp.miss||sp.out){hint.textContent='已按 '+sp.p+' 填好(单价来自内置价格表),不对就直接改';hint.style.color='#2f6b32';}
              else{var who=sp.label?('(认成 '+sp.label+')'):'';hint.textContent='已按 '+sp.p+' 填好'+who+' —— 内置表里没有这家单价,三个价自己填';hint.style.color='#96500f';}
            }
          });
          p.appendChild(row);
        });
      }
      line('— 加一家(同名会覆盖):','margin-top:4px;opacity:.7;');
      field('如 智谱','label','大名');
      field('点上面一行自动填,或写 provider_id','match','匹配');
      field('留空=用 ZCode 里配的','key','Key');
      field('留空=不查余额','url','余额');
      field('如 data.balance','path','路径');
      field('中转站那种:取"已用"的接口','usedUrl','已用');
      field('如 0.0001(倍率)','scale','乘数');
      field('元/百万','hit','命中');field('元/百万','miss','未中');field('元/百万','out','输出');
      hint=line('匹配词 = 在 provider_id/model_id 里找的子串;单价填一个数就行;只有 DeepSeek 那种按时段分两档计价的才写两个:1,2 = 谷价,峰价','opacity:.7;color:#1f6076;');
      line('填了「已用」接口 = 余额按 总额-已用 算(OneAPI/New API 中转站);乘数用于那种按万分之一报数的接口','opacity:.7;');
      var bar=document.createElement('div');bar.style.cssText='display:flex;gap:8px;margin-top:6px;';
      var b1=document.createElement('span');b1.textContent='💾 保存';b1.style.cssText='cursor:pointer;padding:2px 10px;border:2px solid #6b4423;border-radius:4px;background:#efd4a0;';
      b1.addEventListener('click',function(){
        var o={};for(var k2 in inp)o[k2]=inp[k2].value;
        if(!String(o.label||'').trim()||!String(o.match||'').trim()){hint.textContent='⚠ 大名和匹配词都得填';hint.style.color='#a33b2a';return;}
        emitReq('apiadd',JSON.stringify(o));
        hint.textContent='已保存,气泡会回一句确认';hint.style.color='#2f6b32';
        setTimeout(function(){p.remove()},700);
      });
      var b2=document.createElement('span');b2.textContent='取消';b2.style.cssText='cursor:pointer;padding:2px 10px;border:2px solid #c09355;border-radius:4px;background:#fdf3d9;';
      b2.addEventListener('click',function(){p.remove();});
      bar.appendChild(b1);bar.appendChild(b2);p.appendChild(bar);
      document.body.appendChild(p);
      var pr2=p.getBoundingClientRect();
      p.style.left=Math.max(8,Math.min(ev.clientX,innerWidth-pr2.width-8))+'px';
      p.style.top=Math.max(8,Math.min(ev.clientY-pr2.height-8,innerHeight-pr2.height-8))+'px';
      setTimeout(function(){var h=function(e2){if(p.contains(e2.target))return;p.remove();document.removeEventListener('mousedown',h);};document.addEventListener('mousedown',h);var h2=function(e2){if(e2.key==='Escape'){p.remove();document.removeEventListener('keydown',h2);}};document.addEventListener('keydown',h2);},0);
    });
    item('🔍 调整大小(当前 '+(curS*100|0)+'%)',function(){
      var ns=scales[(scales.indexOf(curS)+1)%scales.length];
      try{localStorage.setItem('tokPetScale',String(ns))}catch(_){ }
      d.dataset.s=String(ns);
      var cp=PETS.find(function(pp){return pp.slug===(d.dataset.slug||PETS[0].slug)})||PETS[0];
      d.style.width=(192*ns)+'px';d.style.height=(208*ns)+'px';
      d.style.backgroundSize=(8*192*ns)+'px '+(cp.rows*208*ns)+'px';
      d.style.backgroundPosition='0px 0px';
    });
    // 隐藏 = 撤掉元素 + 立一个"本页面会话内不再重建"的标志(见模板开头的守卫)。
    // 老写法只设 display:none,元素还留在 DOM 里,守护重启也不会恢复它 —— 菜单承诺的"重启后恢复"是假的
    item('🙈 隐藏(重启 ZCode 后恢复)',function(){window.__tokPetHidden=1;d.remove();});
    document.body.appendChild(m);
    var mw=m.getBoundingClientRect();
    m.style.left=Math.min(ev.clientX,innerWidth-mw.width-8)+'px';
    m.style.top=Math.min(ev.clientY,innerHeight-mw.height-8)+'px';
    setTimeout(function(){
      document.addEventListener('mousedown',function h(e){if(m.contains(e.target))return;m.remove();document.removeEventListener('mousedown',h);});
      document.addEventListener('keydown',function h2(e){if(e.key==='Escape'){m.remove();document.removeEventListener('keydown',h2);}});
    },0);
  };
  window.addEventListener('contextmenu',function(ev){
    var dd=document.getElementById('tok-pet');
    if(!dd||!dd.contains(ev.target))return;
    ev.preventDefault();try{ev.stopImmediatePropagation()}catch(_){ }
    window.__tokPetMenu(ev);
  },true);
}
d.dataset.slug=PET.slug;
(function(){ // 每拍把精灵图与当前宠物对齐:元素是复用的,切宠物只改 dataset 会让图和网格错位(曾出现"显示旺财、网格按 Boba 裁")
  var s1=parseFloat(d.dataset.s)||0.55;
  d.style.backgroundImage='url('+PET.sprite+')';
  d.style.backgroundSize=(8*192*s1)+'px '+(PET.rows*208*s1)+'px';
})();
window.__tokPetSatPct=SAT.pct;window.__tokPetAch=ACH;window.__tokPetPomLeft=POM?POM.left:null;window.__tokPetCheckin=CHECKIN;window.__tokPetModel=EXT.model||null;window.__tokPetProv=(EXT.model&&EXT.model.provTxt)||'';
window.__tokPetBind=BIND; // 每拍刷新:菜单那种常驻闭包靠它拿到当前有效的绑定名(emitReq 里读)
window.__tokPetWx=${JSON.stringify(WEATHER.txt)}; // 天气诊断口
window.__tokPetDrop=dropFood;window.__tokPetWalk=startWalk; // 每拍重注册(元素复用时创建分支不重跑)
d._state=S;d._night=NIGHT?1:0;
var bs=parseFloat(d.dataset.s)||0.55,bk=bs/0.55;
if(d._bubble){d._bubble.style.fontSize=(12*bk).toFixed(1)+'px';d._bubble.style.padding=(6*bk).toFixed(1)+'px '+(8*bk).toFixed(1)+'px';d._bubble.style.marginBottom=(8*bk).toFixed(1)+'px';d._bubble.style.minWidth=(165*bk).toFixed(1)+'px';if(d._bubble._tail){d._bubble._tail.style.width=(10*bk).toFixed(1)+'px';d._bubble._tail.style.height=(10*bk).toFixed(1)+'px';d._bubble._tail.style.bottom=(-6*bk).toFixed(1)+'px';}if(d._bubble._satRow){d._bubble._satRow.style.gap=(3*bk).toFixed(1)+'px';d._bubble._satRow.style.marginTop=(4*bk).toFixed(1)+'px';d._bubble._satLbl.style.fontSize=(10*bk).toFixed(1)+'px';d._bubble._satBar.style.height=(8*bk).toFixed(1)+'px';d._bubble._satCap.style.fontSize=(9*bk).toFixed(1)+'px';if(d._bubble._mdl)d._bubble._mdl.style.fontSize=(9*bk).toFixed(1)+'px';}}
var CLAMPV='5';   // 同上:守卫与赋值共用一个常量(5:宠物本体自愈 + 气泡整体夹进视口)
if(window.__tokPetClampV!==CLAMPV){
  window.__tokPetClampV=CLAMPV;
  if(window.__tokPetClampTimer)clearInterval(window.__tokPetClampTimer); // 升版本重注册时先清旧循环,防双循环打架
  window.__tokPetClampTimer=setInterval(function(){
    var d=document.getElementById('tok-pet');if(!d)return;
    healPet(d);   // 本体跑出视口/尺寸塌了先救回来:气泡是跟着本体定位的,本体在屏幕外气泡就会挂在屏幕边上被裁
    var b=d._bubble;if(!b||b.style.display==='none')return;
    var bk=parseFloat(d.dataset.s||'0.55')/0.55;
    var pr=d.getBoundingClientRect(),br=b.getBoundingClientRect();
    // 顶部禁入带:ZCode 用 Computer Use 时会在屏幕顶正中显示「正在操作电脑」胶囊,
    // 那个胶囊是主进程开的独立窗口(alwaysOnTop 'screen-saver',占屏幕顶部 6+56=62px),
    // 页面里的元素永远压不过它 ⇒ 气泡伸进这条带就会被盖掉首行,所以按"去掉禁入带"的可用高度判断翻转。
    var TOP_SAFE=64;
    var gap=8*bk;                                   // 气泡与宠物之间的间距(随宠物大小缩放)
    var roomAbove=pr.top-gap-TOP_SAFE;              // 上方可用高度(不含禁入带)
    var roomBelow=innerHeight-pr.bottom-gap;        // 下方可用高度
    var below=br.height>roomAbove&&roomBelow>=roomAbove; // 上方塞不下就翻到下面;两边都塞不下时选空间大的一侧
    b.dataset.pos=below?'below':'above';
    var t=b._tail;
    if(below){b.style.bottom='auto';b.style.top='100%';b.style.marginBottom='0px';b.style.marginTop=(8*bk).toFixed(1)+'px';
      t.style.top=(-7*bk).toFixed(1)+'px';t.style.bottom='auto';t.style.borderRight='none';t.style.borderBottom='none';t.style.borderLeft='3px solid #6b4423';t.style.borderTop='3px solid #6b4423';
    }else{b.style.top='auto';b.style.bottom='100%';b.style.marginTop='0px';b.style.marginBottom=(8*bk).toFixed(1)+'px';
      t.style.bottom=(-7*bk).toFixed(1)+'px';t.style.top='auto';t.style.borderLeft='none';t.style.borderTop='none';t.style.borderRight='3px solid #6b4423';t.style.borderBottom='3px solid #6b4423';
    }
    // 横向钳制:dx 只从宠物中心与气泡宽度推(都不含旧 transform),幂等无反馈;
    // 旧写法从"含上次修正的 rect"反推 dx,贴边时 +dx/0 交替 → 气泡左右抽动
    var pc=pr.left+pr.width/2,w=b.offsetWidth,rawLeft=pc-w/2;
    var wantLeft=Math.max(4,Math.min(rawLeft,innerWidth-4-w));
    b.style.transform='translateX(calc(-50% + '+(wantLeft-rawLeft).toFixed(1)+'px))';
    // 气泡整体必须在视口内:贴到屏幕上/下边时补一点间距(否则首行会被屏幕边裁掉,看着像被上面那条带截了)。
    // marginTop/Bottom 每拍都被上面重设成 8*bk,所以这里的加量是幂等的。
    var br2=b.getBoundingClientRect(),PAD=4;
    if(br2.top<PAD){var dy1=PAD-br2.top;
      if(below)b.style.marginTop=(8*bk+dy1).toFixed(1)+'px';else b.style.marginBottom=Math.max(0,8*bk-dy1).toFixed(1)+'px';
    }else if(br2.bottom>innerHeight-PAD){var dy2=br2.bottom-(innerHeight-PAD);
      if(below)b.style.marginTop=Math.max(0,8*bk-dy2).toFixed(1)+'px';else b.style.marginBottom=(8*bk+dy2).toFixed(1)+'px';
    }
  },300);
}
// 状态与气泡更新(拖拽中不打扰;摸头/喂食的临时动作优先;散步中不打断跑步动画)
if(!(d._ovl>Date.now())&&!d._drag&&!d._walking&&window.__tokPetSet)window.__tokPetSet(S);
if(typeof FEEDTICK==='number'){if(typeof d._lastFeedTick==='number'&&FEEDTICK>d._lastFeedTick&&window.__tokPetDrop)window.__tokPetDrop(d);d._lastFeedTick=FEEDTICK;}
if(d._zzz)d._zzz.style.display=NIGHT?'block':'none';
if(d._bubble){
  var now3=Date.now();
  if(OVR&&OVR.until>now3)window.__tokGotOvrAt=now3;
  if(d._ovrTxt!==((OVR&&OVR.until>now3)?OVR.text:'')){d._ovrTxt=(OVR&&OVR.until>now3)?OVR.text:'';d._ovrAt=now3;} // 记下当前这段 override 是什么时候出现的
  var iOK=d._instant&&d._instant.until>now3;
  var WK=EXT.work||null;   // 实时工作框内容(守护每拍下发,阶段变化即重注入)
  // 优先级:戳晕彩蛋 > 比 override 更新的点击回应 > override(工具反应/番茄钟到/喂食等) > 无
  var ovTxt=(d._instant&&d._instant.pri==='egg'&&iOK)?d._instant.text:(iOK&&(!(OVR&&OVR.until>now3)||(d._ovrAt||0)<=(d._instant.at||0))?d._instant.text:((OVR&&OVR.until>now3)?OVR.text:''));
  var slots=[d._bubble._p1,d._bubble._p2,d._bubble._p3];
  // 对话框三种默认态互斥:点击回应(临时) > 实时工作框(工作中) > token 统计(空闲)
  if(ovTxt){slots.forEach(function(sl){sl.style.display='none'});d._bubble._p4.style.display='none';d._bubble._work.style.display='none';d._bubble._ov.textContent=ovTxt;d._bubble._ov.style.display='block';d._bubble._satRow.style.display='none';}
  else if(WK){d._bubble._ov.style.display='none';d._bubble._work.style.display='flex';renderWork(d._bubble,WK);slots.forEach(function(sl){sl.style.display='none'});d._bubble._p4.style.display='none';d._bubble._satRow.style.display='none';}
  else{d._bubble._ov.style.display='none';d._bubble._work.style.display='none';
  for(var pi=0;pi<3;pi++){
    var bd=BADGES[pi];
    if(bd){var cf=CLS[bd.c]||CLS.turn;
      slots[pi].style.display='inline-block';slots[pi].textContent=bd.t;
      slots[pi].style.whiteSpace=bd.w?'normal':'nowrap';   // 多会话汇总的长胶囊:文本里埋了零宽空格,允许在 + 号后自动换行
      slots[pi].style.color=cf.c;slots[pi].style.borderColor=cf.b;slots[pi].style.background=cf.g;
    } else slots[pi].style.display='none';
  }
  // 进度条=等级进度(星露谷式绿条),文字里的 🍖N% 才是饱食度
  var spct=Math.max(0,Math.min(100,SAT.pct||0));
  var lpct=Math.max(0,Math.min(100,SAT.lvp!=null?SAT.lvp:0));
  d._bubble._satFill.style.width=lpct+'%';
  d._bubble._satFill.style.background='repeating-linear-gradient(90deg,#8fbf5f 0 6px,#6fa348 6px 9px)';
  d._bubble._satCap.textContent=SAT.maxLv?'已满级':('→Lv.'+((SAT.lv||1)+1)+' '+Math.round(lpct)+'%');
  d._bubble._satLbl.textContent='Lv.'+SAT.lv+' '+SAT.title+' 🍖'+spct+'%';
  d._bubble._satLbl.style.color=spct<15?'#a33b2a':'#3f6b2f';
  var MD=EXT.model||null;
  if(MD&&MD.cur){d._bubble._mdl.style.display='block';d._bubble._mdl.textContent='🤖 '+MD.cur+(MD.sub?' · 订阅':(MD.billed?' · API 按量':' · API 未配价'));}
  else d._bubble._mdl.style.display='none';
  d._bubble._satRow.style.display=BADGES.length?'flex':'none';
  if(POM&&POM.left){d._bubble._p4.style.display='inline-block';d._bubble._p4.textContent='🍅 番茄钟 '+POM.left+' 分';}else d._bubble._p4.style.display='none';
  }
  d._bubble.style.display=(ovTxt||BADGES.length||WK)?'flex':'none';

}
})()`;
}
// 模板不变量只序列化一次(每拍注入不再重复 stringify;WEATHER.txt 会变,保持实时求值)
const FRAMES_JSON = JSON.stringify(FRAMES), PAGE_CSS_JSON = JSON.stringify(PAGE_CSS), PETS_JSON = JSON.stringify(PETS);
module.exports = { petJs, setBindName };
