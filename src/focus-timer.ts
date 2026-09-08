import type { Task } from "./task-model";
export interface FocusSession { id:string; projectId:string; title:string; elapsed:number; startedAt:number|null }
const KEY="codenotch.focus.v1";
export class FocusTimer {
  session:FocusSession|null=null;
  constructor(private changed:()=>void) {
    try {const s=JSON.parse(localStorage.getItem(KEY)||"null");
      if(s && typeof s.id==="string" && typeof s.projectId==="string" && typeof s.title==="string" && Number.isFinite(s.elapsed) && s.elapsed>=0 && (s.startedAt===null || (Number.isFinite(s.startedAt)&&s.startedAt>0))) this.session=s;
    } catch {}
  }
  seconds(now=Date.now()) {const s=this.session;return s?Math.floor((s.elapsed+(s.startedAt===null?0:Math.max(0,now-s.startedAt)))/1000):0;}
  start(task:Task) {this.session={id:task.id,projectId:task.projectId,title:task.title,elapsed:0,startedAt:Date.now()};this.save();}
  toggle() {const s=this.session;if(!s)return;if(s.startedAt===null)s.startedAt=Date.now();else {s.elapsed+=Math.max(0,Date.now()-s.startedAt);s.startedAt=null;}this.save();}
  stop() {this.session=null;this.save();}
  private save() {try {if(this.session)localStorage.setItem(KEY,JSON.stringify(this.session));else localStorage.removeItem(KEY);}catch{}this.changed();}
}
export function timerText(seconds:number) {
  const minutes=Math.floor(seconds/60),rest=seconds%60;
  return minutes<100?String(minutes).padStart(2,"0")+":"+String(rest).padStart(2,"0"):Math.floor(minutes/60)+"h "+String(minutes%60).padStart(2,"0");
}
