// Phone Sync (Settings page): QR pairing, encrypted Firestore push,
// paste-pairing pull, online/offline chip. Degrades to a setup hint when
// Firebase env vars are absent instead of crashing.
import { exportVaultKey, generateVaultKey } from '../crypto/vault';
import { pullAndDecrypt, pushEncrypted, ReadOnlyWorkspaceError } from '../storage/db';
import { deduplicateWorkspace } from '../storage/workspaceOps';
import { decodePairingPayload, encodePairingPayload, mountPairingPanel } from './pairing';
import { goTab, lsGet, lsSet, markSyncedCopy, store } from './state';
import { copyText, el, errText, newId, toast } from './util';

const WSID_KEY = 'cv.wsId';

function firebaseConfigured(): boolean {
  const env = import.meta.env;
  return Boolean(env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_API_KEY && env.VITE_APPCHECK_SITE_KEY);
}

function currentWsId(): string {
  const ws = store.workspace;
  if (ws) return ws.id;
  let id = lsGet(WSID_KEY);
  if (!id) {
    id = newId();
    lsSet(WSID_KEY, id);
  }
  return id;
}

export function mountSync(root: HTMLElement): void {
  const configured = firebaseConfigured();

  const netChip = el('span', { class: 'chip', id: 'syncNetChip' });
  function refreshNet(): void {
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    netChip.className = `chip ${online ? 'chip--ok' : 'chip--warn'}`;
    netChip.textContent = online ? 'ONLINE — sync available' : 'OFFLINE — cached data still usable';
  }
  window.addEventListener('online', refreshNet);
  window.addEventListener('offline', refreshNet);
  refreshNet();

  const statusBox = el('div', { class: 'note', text: 'Idle. Click Connect your phone to pair with the mobile app.' });
  function setStatus(kind: 'note' | 'note--ok' | 'note--warn' | 'note--err', text: string): void {
    statusBox.className = `note ${kind}`;
    statusBox.textContent = text;
  }

  /* ---------- QR phone pairing (key + payload + copyable fallback) ---------- */

  const settingsPage = typeof root.closest === 'function' ? (root.closest('.page') as HTMLElement | null) : null;
  const pairingPanel = mountPairingPanel({
    generatePayload: async () => {
      let key = store.vaultKey;
      let exported = store.vaultKeyString;
      if (!key || !exported) {
        key = await generateVaultKey();
        exported = await exportVaultKey(key);
        store.setVault(key, exported);
      }
      return encodePairingPayload({ wsId: currentWsId(), key: exported });
    },
    onCopy: (value) => {
      void copyText(value, 'Pairing string');
    },
    onStatus: setStatus,
    observeLeaveRoot: settingsPage,
  });

  /* ---------- push ---------- */

  const pushBtn = el('button', { class: 'btn btn-primary' }, 'Push encrypted graph to Firestore');
  pushBtn.disabled = !configured || !store.workspace;
  pushBtn.addEventListener('click', () => {
    void (async () => {
      const ws = store.workspace;
      const key = store.vaultKey;
      if (!ws) {
        setStatus('note--warn', 'No workspace — load documents on the Documents page first.');
        return;
      }
      if (!key) {
        setStatus('note--warn', 'Click Connect your phone first to create a vault key.');
        return;
      }
      pushBtn.disabled = true;
      setStatus('note', 'Encrypting on this device and uploading…');
      try {
        await pushEncrypted(ws.id, { graph: ws.graph, tokenMap: ws.tokenMap }, key);
        markSyncedCopy(ws.id);
        setStatus('note--ok', 'Pushed — the server holds only ciphertext, never plaintext.');
        toast('Encrypted workspace pushed', 'ok');
      } catch (e) {
        if (e instanceof ReadOnlyWorkspaceError) {
          setStatus('note--warn', `Read-only: ${e.message}`);
        } else {
          setStatus('note--err', `Push failed: ${errText(e)}`);
        }
      } finally {
        pushBtn.disabled = !configured || !store.workspace;
      }
    })();
  });

  /* ---------- pull ---------- */

  const pullInput = el('textarea', {
    class: 'pairing',
    id: 'pullPairInput',
    spellcheck: 'false',
    'aria-label': 'Paste a pairing string here to pull the encrypted workspace',
    placeholder: 'Paste the pairing string from your phone here…',
  });
  const pullBtn = el('button', { class: 'btn btn-primary' }, 'Pull & decrypt');
  pullBtn.disabled = !configured;
  pullBtn.addEventListener('click', () => {
    void (async () => {
      const pair = pullInput.value.trim();
      if (!pair) {
        setStatus('note--warn', 'Paste a pairing string first.');
        return;
      }
      pullBtn.disabled = true;
      setStatus('note', 'Fetching ciphertext and decrypting locally…');
      try {
        const result = await pullAndDecrypt(pair);
        if (!result) {
          setStatus('note--warn', 'No encrypted workspace found for that pairing string.');
        } else {
          let wsId = 'synced';
          try {
            wsId = decodePairingPayload(pair).wsId;
          } catch {
            /* pairing format optional — decrypt result is what matters */
          }
          const prev = store.workspace;
          const { workspace: deduped } = deduplicateWorkspace({
            id: wsId,
            name: `Synced workspace (${wsId.slice(0, 8)}…)`,
            graph: result.graph,
            tokenMap: result.tokenMap,
            docs: prev?.docs ?? [],
            payloadLog: prev?.payloadLog ?? [],
            updatedAt: Date.now(),
          });
          markSyncedCopy(wsId);
          store.setWorkspace(deduped);
          setStatus('note--ok', `Workspace ${wsId.slice(0, 8)}… decrypted on this device. The Requests page now has the graph.`);
          toast('Synced workspace loaded', 'ok');
        }
      } catch (e) {
        setStatus('note--err', `Pull/decrypt failed: ${errText(e)}`);
      } finally {
        pullBtn.disabled = !configured;
      }
    })();
  });

  /* ---------- firebase guard ---------- */

  let guard: HTMLElement | null = null;
  if (!configured) {
    guard = el(
      'div',
      { class: 'banner banner--info' },
      el('strong', {}, 'Firebase not configured — sync is disabled.'),
      el('p', { style: 'margin:6px 0 4px' }, 'Copy web/.env.example to web/.env and fill in:'),
      el(
        'pre',
        { class: 'code' },
        [
          'VITE_FIREBASE_API_KEY=…',
          'VITE_FIREBASE_AUTH_DOMAIN=…',
          'VITE_FIREBASE_PROJECT_ID=…',
          'VITE_FIREBASE_STORAGE_BUCKET=…',
          'VITE_FIREBASE_MESSAGING_SENDER_ID=…',
          'VITE_FIREBASE_APP_ID=…',
          'VITE_APPCHECK_SITE_KEY=…   (App Check reCAPTCHA — required for AI Logic)',
        ].join('\n'),
      ),
      el('p', { style: 'margin:6px 0 0' }, 'Everything else — documents, request checks and drafts — still works offline without these keys.'),
    );
  }

  function wsNoteText(): string {
    const ws = store.workspace;
    return ws
      ? `Workspace loaded: “${ws.name}” — ${ws.graph.products.length} SKU(s), ${ws.graph.dealRules.length} rule(s) ready to sync.`
      : 'No workspace loaded — load documents on the Documents page before pushing.';
  }

  const wsNoteP = el('p', {}, wsNoteText());

  function refreshWorkspaceDependents(): void {
    pushBtn.disabled = !configured || !store.workspace;
    wsNoteP.textContent = wsNoteText();
    if (!store.vaultKey && pairingPanel.isOpen()) {
      pairingPanel.hide('manual');
    }
  }
  store.subscribe(refreshWorkspaceDependents);

  root.replaceChildren(
    el(
      'div',
      { class: 'section' },
      el('div', { class: 'section-head' }, el('h2', { class: 'section-title' }, 'Phone sync'), netChip),
      wsNoteP,
      el('div', { class: 'btn-row' }, el('button', { class: 'btn btn-secondary', id: 'syncGoIngest' }, 'Open Documents')),
    ),
    guard ?? el('div', { hidden: '' }),
    el(
      'div',
      { class: 'section' },
      el('h3', {}, '1 · Connect your phone'),
      el('p', {}, 'Your encryption key stays on this device. Scan the QR code with the phone app to pair.'),
      pairingPanel.element,
    ),
    el(
      'div',
      { class: 'section' },
      el('h3', {}, '2 · Push encrypted workspace'),
      el('p', {}, 'Your workspace is encrypted on this device first. The server stores unreadable ciphertext — never your documents in plain text.'),
      pushBtn,
    ),
    el(
      'div',
      { class: 'section' },
      el('h3', {}, '3 · Pull from another device'),
      el('p', {}, 'Paste the pairing string from the phone to bring its encrypted workspace back to this device.'),
      pullInput,
      el('div', { class: 'btn-row' }, pullBtn),
    ),
    el('div', { class: 'section' }, statusBox),
  );

  root.querySelector('#syncGoIngest')?.addEventListener('click', () => {
    pairingPanel.hide('leave');
    goTab('documents');
  });
}
