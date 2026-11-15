# Localized guide captures implementation plan

**Goal:** Show the real dashboard in each guide's language using synthetic data.

**Approach:** Extend the existing loopback-only capture scripts to select the
application locale, resolve controls through the shipped catalogs, and record
image evidence. Capture each guide view in English, Korean, Japanese, Simplified
Chinese and Spanish. Wire each guide and its image viewer to its matching images.
Retain the historical videos and the current media snapshot's other files.

**Ruling:** The user also requested a React calendar with an explicit completion
control. Capture the updated calendar and add matching five-language instructions.
Split the guide work into two review units to keep each full raw diff within the
repository's required review limit.

**Constraints:** Do not alter the rendered DOM or translate API/user data. Use
synthetic fixtures, fixed time and reserved identities. Publish the immutable
media snapshot before pushing a lock that references it. Preserve section IDs,
language navigation, code examples and existing guide behavior.

**Verification:** Check all image paths, hashes, language-specific UI labels and
media dimensions; exercise desktop/mobile guides and image viewer; run the
documentation and media checks. Local rendering does not establish deployment.

## Tasks

1. Extend and validate capture automation, including Settings and the time picker.
2. Produce and inspect all five locale captures; record source and image evidence.
3. Update guide image links, captions and the media manifest/lock without changing
   unrelated media. Prepare the immutable snapshot and validate it offline.
4. Verify the rendered pages, local links, image viewer and documentation checks.
