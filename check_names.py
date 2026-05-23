import urllib.request
import json
import re

# Fetch Atlas Data
url = 'https://api.atlasacademy.io/export/JP/basic_svt.json'
with urllib.request.urlopen(url) as response:
    atlas_data = json.loads(response.read().decode())

atlas_dict = {}
for s in atlas_data:
    if s.get('type') in ['normal', 'heroine']:
        atlas_dict[s.get('collectionNo')] = s.get('name')

# Read 一覧.md
input_file = '/Users/shumairisawa/editor/fgo/kizuna/一覧.md'
mismatches = []
matches = 0

with open(input_file, 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        parts = re.split(r'\t+', line)
        if len(parts) >= 14:
            try:
                collection_no = int(parts[0])
                name_in_md = parts[1]
                
                atlas_name = atlas_dict.get(collection_no)
                
                if atlas_name is None:
                    mismatches.append(f"No.{collection_no} not found in Atlas API! (MD name: {name_in_md})")
                else:
                    # Simplify names for comparison (remove brackets, spaces)
                    clean_md = re.sub(r'〔.*?〕|/.*|（.*?）', '', name_in_md).replace('・', '').replace(' ', '')
                    clean_atlas = re.sub(r'〔.*?〕|/.*|（.*?）', '', atlas_name).replace('・', '').replace(' ', '')
                    
                    if clean_md != clean_atlas:
                        mismatches.append(f"Mismatch at No.{collection_no}: MD='{name_in_md}' vs Atlas='{atlas_name}'")
                    else:
                        matches += 1
            except ValueError:
                continue

print(f"Total Matches: {matches}")
print(f"Total Mismatches: {len(mismatches)}")
if mismatches:
    print("Sample Mismatches:")
    for m in mismatches[:20]:
        print("  " + m)

