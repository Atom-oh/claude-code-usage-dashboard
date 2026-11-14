#!/usr/bin/env python3
"""Build deterministic HyperFrames scenes and captions from frozen measurements."""
from pathlib import Path
import hashlib,html,json,re,struct,textwrap,posixpath
ROOT=Path(__file__).resolve().parent
script=json.loads((ROOT/'script.json').read_text());timing=json.loads((ROOT/'timing.json').read_text());captions=json.loads((ROOT/'captions.en.json').read_text())
assert timing['script_sha256']==hashlib.sha256((ROOT/'script.json').read_bytes()).hexdigest()
assert [s['id'] for s in script['scenes']]==[s['id'] for s in timing['scenes']]==list(captions)
FPS=timing['fps'];W=1760;H=636
profiles={
'guide-overview.png':([510,180,2320,1220],[530,390,2260,850]),
'guide-executive.png':([510,180,2320,1400],[530,400,2260,850]),
'guide-trends.png':([510,180,2320,1450],[530,370,2260,1000]),
'guide-cost-summary.png':([510,180,2320,1500],[530,500,2260,870]),
'guide-reliability.png':([510,180,2320,1450],[530,400,2260,890]),
'guide-analytics.png':([510,180,2320,1500],[530,420,2260,950]),
'guide-installation.png':([510,180,2320,1500],[530,380,2260,1000]),
'guide-user-detail.png':([0,0,2240,1354],[0,0,2240,870]),
'guide-cost.png':([0,0,2240,1054],[0,0,2240,800]),
'guide-economics.png':([0,0,2240,1250],[0,0,2240,980]),
'guide-usage.png':([0,0,2240,1248],[0,0,2240,900]),
'guide-tools.png':([0,0,2240,1138],[0,0,2240,900]),
'guide-skills.png':([0,0,2240,970],None),
'guide-task-context.png':([0,0,1880,850],None),
'guide-task-trace.png':([230,100,2420,1430],[260,490,1870,790]),
 'tour-task-trace.png':([230,100,2420,1430],[260,480,1870,790]),
 'tour-language-en.png':([0,0,2880,2000],[0,1280,860,720]),
}

def asset(name):return ROOT/'assets/img'/name

def dimensions(p):
 data=p.read_bytes()
 if p.suffix=='.png':return struct.unpack('>II',data[16:24])
 if p.suffix=='.svg':
  text=data.decode();view=re.search(r'viewBox="([^"]+)"',text)
  if view:return tuple(map(float,view[1].split()[2:]))
  return tuple(float(re.search(r'\b'+v+r'="([\d.]+)',text)[1])for v in ['width','height'])
 raise ValueError(p)

def num(v):return format(v,'.12g')
def esc(v):return html.escape(str(v),quote=True)
def stamp(seconds):
 ms=round(seconds*1000);return f'{ms//3600000:02d}:{ms//60000%60:02d}:{ms//1000%60:02d}.{ms%1000:03d}'

scenes_dir=ROOT/'compositions';scenes_dir.mkdir(exist_ok=True)
root_hosts=[];vtt=['WEBVTT',''];ko_vtt=['WEBVTT',''];chapters=[];story=[];proof=[]
for n,(scene,times) in enumerate(zip(script['scenes'],timing['scenes'])):
 id='tour-'+scene['id'];duration=times['duration_frames']/FPS;start=times['start_frame']/FPS
 if not chapters or chapters[-1]['title']!=scene['chapter']:chapters.append({'title':scene['chapter'],'start':start,'frame':times['start_frame']})
 assert len(captions[scene['id']])==len(scene['segments'])==len(times['marks'])
 for k,mark in enumerate(times['marks']):
  a=times['speech_start_frame']/FPS+mark['time_seconds'];b=times['speech_start_frame']/FPS+(times['marks'][k+1]['time_seconds'] if k+1<len(times['marks']) else times['speech_duration_seconds'])
  assert b>a
  cue=f'{scene["id"]}-{k+1}\n{stamp(a)} --> {stamp(b-.04)}\n'
  vtt.extend([cue+'\n'.join(textwrap.wrap(captions[scene['id']][k],88,break_long_words=False,break_on_hyphens=False)),''])
  ko_vtt.extend([cue+scene['segments'][k],''])
 images=[{'name':name}for name in scene['images']]
 if scene['id']=='economics':images=[{'name':'guide-economics.png','roi':[0,0,2240,870]},{'name':'guide-economics.png','roi':[0,950,2240,850]}]
 if scene['id']=='context':images=[{'name':'guide-task-context.png','roi':[0,0,1880,850]},{'name':'guide-task-context.png','roi':[0,910,2544,518]},{'name':'tour-session-environment.png'}]
 split=scene['id']=='call';end=scene['id']=='finish';shots=[];animations=[]
 for i,item in enumerate(images):
  name=item['name'];path=asset(name);iw,ih=dimensions(path);roi,focus=profiles.get(name,([0,0,iw,ih],None));roi=item.get('roi',roi)
  if 'roi'in item:focus=None
  for bounds in [roi,focus]:
   if bounds:assert bounds[0]>=0 and bounds[1]>=0 and bounds[0]+bounds[2]<=iw+1 and bounds[1]+bounds[3]<=ih+1,(name,bounds,iw,ih)
  vw=850 if split else 1000 if end else W;vh=H
  shotid=f'{id}-shot-{i}';worldid=shotid+'-world';left=i*910 if split else 0
  image_timing=''
  if scene['id'] in ['context','economics'] and i<len(images)-1:
   image_start=0 if i==0 else times['marks'][i]['time_seconds']+script['lead_seconds']
   image_end=times['marks'][i+1]['time_seconds']+script['lead_seconds']+.45
   image_timing=f' class="clip" data-start="{num(image_start)}" data-duration="{num(image_end-image_start)}" data-track-index="{i}"'
  shots.append(f'<div id="{shotid}" class="shot" style="left:{left}px;width:{vw}px;opacity:{1 if split or i==0 else 0}"><div id="{worldid}" class="world" data-layout-allow-overflow="true"><img id="{shotid}-image"{image_timing} data-layout-allow-overflow="true" src="assets/{esc(posixpath.normpath("img/"+name))}" width="{num(iw)}" height="{num(ih)}" style="width:{num(iw)}px;height:{num(ih)}px;left:{num((vw-iw)/2)}px;top:{num((vh-ih)/2)}px" alt="{esc(scene["cue"])}" /></div></div>')
  config={'width':iw,'height':ih,'viewportWidth':vw,'viewportHeight':vh,'roi':roi,'focus':focus,'at':2.5}
  animations.append(f'window.tourCamera(tl, document.getElementById({json.dumps(worldid)}), {json.dumps(config)});')
  if not split:
   at=0 if i==0 else (times['marks'][min(i,len(times['marks'])-1)]['time_seconds']+script['lead_seconds'] if scene['id'] in ['context','economics'] else duration*.49)
   animations.append(f'gsap.set("#{shotid}", {{opacity:{1 if i==0 else 0}}});')
   if i:
    animations.append(f'tl.fromTo("#{shotid}", {{opacity:0}}, {{opacity:1,duration:.45,immediateRender:false}}, {num(at)});')
    animations.append(f'tl.to("#{id}-shot-{i-1}", {{opacity:0,duration:.45}}, {num(at)});')
  proof.append({'scene':scene['id'],'image':str(path.resolve().relative_to(ROOT.parents[1])),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'dimensions':[iw,ih],'roi':roi,'focus':focus})
 outro='<div class="outro-copy"><h2>사용설명서에서 이어서 살펴보세요</h2><p>모든 메뉴와 실무 절차 · 확대해서 보는 화면 · 설치와 운영 가이드</p><p class="url">www.atomai.click/claude-code-usage-dashboard/</p><div class="outro-languages">English · 简体中文 · 日本語 · Español · 한국어</div></div>' if end else ''
 note='OIDC 기기 수집 구성 예시 · 두 Express 상자는 같은 앱의 논리적 역할' if scene['id']=='architecture' else '실제 애플리케이션 화면 · 예시 데이터' if not end else '같은 기간 → 비용 구성 → 사용자 작업 → 호출과 도구'
 content=f'''<template>
<link rel="stylesheet" href="styles.css" />
<style>#root{{position:absolute;inset:0;width:100%;height:100%;overflow:hidden}}</style>
<div id="root" data-composition-id="{id}" data-width="1920" data-height="1080" data-duration="{num(duration)}">
<div class="frame-content" id="{id}-content" style="opacity:0">
<div class="topline"><img class="brand-mark" src="assets/img/favicon.svg" alt="" /><span class="brand">ccdash</span><span class="chapter">{esc(scene['chapter'])}</span><span class="proof">예시 데이터</span><span class="page-no">{n+1:02d} / {len(script['scenes']):02d}</span></div>
<h1 class="title">{esc(scene['title'])}</h1><p class="cue">{esc(scene['cue'])}</p>
<div class="stage">{''.join(shots)}</div>{outro}<p class="context-note">{esc(note)}</p>
</div></div>
<script>(function(){{const tl=gsap.timeline({{paused:true}});{''.join(animations)}
tl.fromTo("#{id}-content",{{opacity:0,y:14}},{{opacity:1,y:0,duration:.45,ease:"power2.out"}},0);
{'' if end else f'tl.to("#{id}-content",{{opacity:0,duration:.20}}, {num(duration-.20)});'}
tl.to({{}},{{duration:{num(duration)}}},0);window.__timelines=window.__timelines||{{}};window.__timelines["{id}"]=tl;}})();</script>
</template>'''
 (scenes_dir/(scene['id']+'.html')).write_text(content+'\n')
 root_hosts.append(f'<div class="scene-host clip" id="host-{scene["id"]}" data-composition-id="{id}" data-composition-src="compositions/{scene["id"]}.html" data-start="{num(start)}" data-duration="{num(duration)}" data-track-index="{n+1}" data-width="1920" data-height="1080"></div>')
 story.append(f'## Frame {n+1}: {scene["id"]}\n\nstatus: built\nsrc: compositions/{scene["id"]}.html\nstart: {num(start)}\nduration: {num(duration)}\nmotion: ui-focus-zoom + stat-bars-and-fills; bounded focus and sustained hold\n\nPurpose: {scene["id"].replace("-"," ")}. Use the actual source captures listed in script.json; narration and captions follow the measured speech marks.\n')
root=f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"/><meta name="viewport" content="width=1920,height=1080"/><title>ccdash — Detailed product tour</title><link rel="stylesheet" href="styles.css"/><script src="runtime/gsap.min.js"></script><script src="camera.js"></script></head><body><div id="root" data-composition-id="product-tour" data-start="0" data-duration="{num(timing['duration_seconds'])}" data-width="1920" data-height="1080">{''.join(root_hosts)}<div class="progress"><div id="progress-fill" class="progress-fill"></div></div></div><script>window.__timelines=window.__timelines||{{}};const tl=gsap.timeline({{paused:true}});tl.fromTo("#progress-fill",{{scaleX:0}},{{scaleX:1,duration:{num(timing['duration_seconds'])},ease:"none"}},0);window.__timelines["product-tour"]=tl;</script></body></html>'''
(ROOT/'index.html').write_text(root+'\n');(ROOT/'captions.en.vtt').write_text('\n'.join(vtt));(ROOT/'captions.ko.vtt').write_text('\n'.join(ko_vtt));(ROOT/'chapters.json').write_text(json.dumps(chapters,ensure_ascii=False,indent=2)+'\n');(ROOT/'visual-evidence.json').write_text(json.dumps(proof,indent=2)+'\n');(ROOT/'STORYBOARD.md').write_text('---\nworkflow: general-video\nexecution_mode: autonomous\nstatus: built\n---\n\n# Detailed product tour\n\nKorean narration and English captions; synthetic product screens. Runtime is '+stamp(timing['duration_seconds'])+'. Each scene uses measured speech plus a lead-in and tail. Source truth is script.json; geometry and hashes are in visual-evidence.json.\n\n'+'\n'.join(story));print(json.dumps({'scenes':len(script['scenes']),'frames':timing['duration_frames'],'seconds':timing['duration_seconds'],'caption_cues':sum(len(v)for v in captions.values())}))
