"""Readable static preview of the same logical graph as the Archify document."""
from pathlib import Path
from html import escape
import json,textwrap
root=Path(__file__).resolve().parents[2]
spec=json.loads((root/'scripts/docs-capture/system.architecture.json').read_text())
out=root/'site/assets/diagrams/system.svg'
width,height=1320,548
nodes={n['id']:dict(n,x=30+n['col']*330,y=54+n['row']*292) for n in spec['components']}
colors={'external':'#64748b','backend':'#416bd6','security':'#9567c9','database':'#1b8a74','frontend':'#416bd6'}
svg=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title description">', '<title id="title">ccdash collection and query architecture</title>', '<desc id="description">The device collection path sends coding telemetry through a local Collector and authenticated ingest gateway to the central Collector and ClickHouse. Organization login authorizes the dashboard to read through the API.</desc>', '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#94a3b8" stroke-width="1.8"/></marker></defs>', '<rect width="1320" height="548" rx="24" fill="#f8fafc"/>', '<style>text{font-family:Arial,Helvetica,sans-serif}.group{font-size:13px;font-weight:700;letter-spacing:2px;fill:#64748b}.label{font-size:20px;font-weight:700;fill:#16243b}.sub{font-size:14px;fill:#53627a}.edge{font-size:13px;fill:#53627a}</style>', '<text x="30" y="28" class="group">COLLECT OBSERVED SIGNALS</text>', '<text x="30" y="320" class="group">SIGN IN AND EXPLORE</text>']
for c in spec['connections']:
 a,b=nodes[c['from']],nodes[c['to']]
 if a['row']==b['row']:
  x1,y1=a['x']+270,a['y']+72;x2,y2=b['x'],b['y']+72
  tx,ty=(x1+x2)/2,y1-16
 else:
  x1,y1=a['x']+135,a['y']+144;x2,y2=b['x']+135,b['y'];tx,ty=x1-12,(y1+y2)/2
 svg.append(f'<path d="M{x1} {y1} L{x2} {y2}" stroke="#94a3b8" stroke-width="2" fill="none" marker-end="url(#arrow)"/>')
 # Two-line labels stay between the wide cards.
 words=textwrap.wrap(c.get('label',''),11 if a['row']==b['row'] else 18)
 if a['row']!=b['row']:svg.append(f'<rect x="{tx-53}" y="{ty-15}" width="106" height="22" rx="4" fill="#f8fafc"/>')
 for i,line in enumerate(words):svg.append(f'<text x="{tx}" y="{ty+(i-len(words)+1)*16}" text-anchor="middle" class="edge">{escape(line)}</text>')
for n in nodes.values():
 x,y=n['x'],n['y'];color=colors[n['type']]
 svg.extend([f'<g data-node="{n["id"]}"><rect x="{x}" y="{y}" width="270" height="144" rx="16" fill="#fff" stroke="#dbe3ef"/>',f'<rect x="{x+20}" y="{y+20}" width="8" height="8" rx="3" fill="{color}"/>',f'<text x="{x+20}" y="{y+62}" class="label">{escape(n["label"])}</text>'])
 for i,line in enumerate(textwrap.wrap(n.get('sublabel',''),31)):svg.append(f'<text x="{x+20}" y="{y+91+i*20}" class="sub">{escape(line)}</text>')
 svg.append('</g>')
svg.append('</svg>');out.write_text('\n'.join(svg)+'\n');print(out)
