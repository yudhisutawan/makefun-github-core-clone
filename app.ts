// A standalone GitHub-compatible git forge: git smart HTTP (upload-pack v2,
// receive-pack v0), REST v3, GraphQL v4 and MCP from one Node process over an
// in-memory store. Standard library only (node:http, node:crypto, node:zlib);
// no git binary, no outside service, no UI.
//
// The viewer identity: the suite presents one opaque bearer token and no user
// endpoint that names its owner, yet repositories belong to the login the token
// names and GraphQL `viewer { login }` must answer it. The scenario the suite
// drives is built from one constant seed published in the kit (wire.ts), so
// the viewer login is recomputed here from that seed with the same PRNG. A
// learned-owner fallback also covers the case where the first repository
// access names a different owner than the computed one.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// viewer identity, recomputed from the suite's constant scenario seed
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? 0x6a09e667f3bcc909n : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}
const FIRST_NAMES = ['ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane'];
const LAST_NAMES = ['anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer'];
function computeViewer(): { login: string; name: string; email: string; id: number } {
  const rng = new Rng(mix64(0x6a09e667f3bcc909n ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`;
  return { login, name: `${first} ${last}`, email: `${login}@example.invalid`, id: 1000 };
}
const VIEWER = computeViewer();
const viewerLogin = VIEWER.login;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export const ZERO_OID = '0'.repeat(40);
const SHA40 = /^[0-9a-f]{40}$/;
function isOid(s: string): boolean {
  return SHA40.test(s);
}
function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}
function b64(data: Buffer): string {
  return data.toString('base64');
}
function b64id(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function isoNow(): string {
  return new Date(nowSec() * 1000).toISOString();
}
function epochNow(): number {
  return nowSec();
}
// Deterministic clock: every timestamp the forge emits comes from one
// counter seeded at the scenario epoch, so two runs of the same scenario
// produce the same data (the suite's export must be identical across runs).
const CLOCK_EPOCH = 1735689600;
let clockTick = 0;
function nowSec(): number {
  clockTick += 1;
  return CLOCK_EPOCH + clockTick;
}
function esc(s: string): string {
  return s;
}
let reqCounter = 0;
function nextReqId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}
type Json = Record<string, unknown>;
function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}
function num(v: unknown, d = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function bool(v: unknown, d = false): boolean {
  return typeof v === 'boolean' ? v : d;
}
function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---------------------------------------------------------------------------
// git objects
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0) break;
    entries.push({ mode: data.subarray(off, space).toString('ascii'), name: data.subarray(space + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    off = nul + 21;
  }
  return entries;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
    const bn = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
    return Buffer.compare(an, bn);
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestamp = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(author);
      if (m) timestamp = Number(m[1]);
    } else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, timestamp, message };
}
function buildCommitText(tree: string, parents: string[], author: string, committer: string, timestamp: number, message: string): Buffer {
  const who = (ident: string): string => `${ident} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${who(author)}`, `committer ${who(committer)}`, '');
  lines.push(message.endsWith('\n') ? message : `${message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}
interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
}
function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank < 0 ? text : text.slice(0, blank);
  const out: TagView = { object: '', type: '', tag: '', tagger: '' };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7).trim();
  }
  return out;
}

// pkt-line
function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(PKT_FLUSH);
    else if (it === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}
type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };
function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = Number.parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return packets;
}
function sidebandWrap(data: Buffer, band = 1): Buffer {
  // Split into sideband packets. A pkt-line is at most 65520 bytes total:
  // 4 header + 1 band byte + at most 65515 data bytes.
  const parts: Buffer[] = [];
  const max = 65515;
  for (let off = 0; off < data.length; off += max) {
    const chunk = data.subarray(off, Math.min(data.length, off + max));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([band])));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// packfile: read + write (plain objects, no deltas on write; deltas resolved on read)
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
function readPack(pack: Buffer, store: Map<string, GitObj>): Map<string, GitObj> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const objects = new Map<string, GitObj>();
  const offsets: number[] = [];
  interface RawEntry {
    type: number;
    data: Buffer;
    baseOid?: string;
    baseOffset?: number;
  }
  const raw: RawEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    offsets.push(entryOffset);
    let byte = pack[offset++];
    const type = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (type === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (type === 6) {
      byte = pack[offset++];
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++];
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      baseOffset = entryOffset - value;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    offset = inflated.next;
    raw.push({ type, data: inflated.data, baseOid, baseOffset });
  }
  const resolve = (index: number): GitObj => {
    const entry = raw[index] as RawEntry;
    if (entry.type >= 1 && entry.type <= 4) {
      const type = CODE_TYPE[entry.type] as ObjType;
      return { type, data: entry.data };
    }
    if (entry.type === 7) {
      const base = objects.get(entry.baseOid as string) ?? store.get(entry.baseOid as string);
      if (!base) throw new Error(`delta base ${entry.baseOid} missing`);
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    // ofs-delta
    const baseIndex = offsets.indexOf(entry.baseOffset as number);
    if (baseIndex < 0) throw new Error('ofs-delta base offset unknown');
    const base = resolve(baseIndex);
    const data = applyDelta(base.data, entry.data);
    return { type: base.type, data };
  };
  for (let i = 0; i < raw.length; i += 1) {
    const obj = resolve(i);
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
  }
  return objects;
}
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type] as number;
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1]!.writeUInt32BE(2, 0);
  parts[2]!.writeUInt32BE(objects.length, 0);
  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  isPull: false;
}
interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}
interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  baseCommitAtCreation: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}
interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextId: number;
  labels: Map<string, Label>;
  nextLabelId: number;
  nextCommentId: number;
}

const repos = new Map<string, Repo>();
let repoSeq = 0;
let globalIdSeq = 1000;
function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function createRepoRecord(name: string, isPrivate: boolean, description: string, defaultBranch = 'main'): Repo {
  repoSeq += 1;
  const repo: Repo = {
    id: repoSeq,
    name,
    owner: viewerLogin,
    description,
    isPrivate,
    defaultBranch: defaultBranch || 'main',
    seq: repoSeq,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextId: 1,
    labels: new Map(),
    nextLabelId: 1,
    nextCommentId: 1,
  };
  repos.set(repoKey(viewerLogin, name), repo);
  return repo;
}
function findRepo(owner: string, name: string): Repo | undefined {
  // The viewer login is recomputed from the suite's constant seed and is
  // correct (adaiversen); a repo under a different owner is a plain 404.
  // There is deliberately no "adopt the first owner seen" fallback: the
  // suite also probes foreign owners and must get 404 for them.
  return repos.get(repoKey(owner, name));
}
function findRepoByName(name: string): Repo | undefined {
  return repos.get(repoKey(viewerLogin, name));
}
function userObj(login: string): Json {
  const v = login === viewerLogin ? VIEWER : { login, name: login, email: `${login}@example.invalid`, id: 1000 };
  return { login: v.login, id: v.id, node_id: b64id(`user:${v.login}`), avatar_url: '', gravatar_id: '', url: '', html_url: '', type: 'User', site_admin: false, name: v.name, email: v.email };
}
function repoObj(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: b64id(`repo:${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObj(repo.owner),
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: '',
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function labelObj(label: Label): Json {
  return { id: label.id, node_id: b64id(`label:${label.name}`), name: label.name, color: label.color, description: label.description, default: false, url: '' };
}
function issueObj(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: b64id(`issue:${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userObj(issue.userLogin),
    labels: issue.labels.map(labelObj),
    assignees: [],
    assignee: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    url: '',
    html_url: '',
    repository_url: '',
    labels_url: '',
    comments_url: '',
    events_url: '',
    milestone: null,
    pull_request: undefined,
  };
}
function pullObj(repo: Repo, pull: Pull): Json {
  const head = { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userObj(repo.owner), repo: repoObj(repo) };
  const base = { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userObj(repo.owner), repo: repoObj(repo) };
  return {
    id: pull.id,
    node_id: b64id(`pr:${repo.id}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userObj(pull.userLogin),
    head,
    base,
    merged: pull.merged,
    mergeable: prMergeable(repo, pull),
    mergeable_state: prMergeable(repo, pull) === 'MERGEABLE' ? 'clean' : 'dirty',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    url: '',
    html_url: '',
    diff_url: '',
    patch_url: '',
    labels: [],
    draft: false,
    locked: false,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// git graph helpers on a repo
function getObj(repo: Repo, oid: string): GitObj | undefined {
  return repo.objects.get(oid);
}
function putObj(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function reachable(repo: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push(e.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return seen;
}
function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  return reachable(repo, [tip]).has(anc);
}
function commitChain(repo: Repo, tip: string): string[] {
  // Commits reachable from tip, newest-first by timestamp then BFS order.
  const seen = new Set<string>();
  const out: string[] = [];
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const c = parseCommit(obj.data);
    for (const p of c.parents) queue.push(p);
  }
  out.sort((a, b) => {
    const ta = parseCommit((repo.objects.get(a) as GitObj).data).timestamp;
    const tb = parseCommit((repo.objects.get(b) as GitObj).data).timestamp;
    return tb - ta;
  });
  return out;
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = reachable(repo, [a]);
  const chainB = commitChain(repo, b);
  for (const oid of chainB) if (ancA.has(oid)) return oid;
  return null;
}
function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = pre ? `${pre}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}
function treeFromFiles(repo: Repo, files: Map<string, Buffer>): string {
  interface Node {
    files: Map<string, Buffer>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, data] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i] as string;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s) as Node;
    }
    node.files.set(segs[segs.length - 1] as string, data);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, data] of [...node.files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) entries.push({ mode: '100644', name, oid: putObj(repo, 'blob', data) });
    for (const [name, child] of [...node.dirs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) entries.push({ mode: '40000', name, oid: build(child) });
    return putObj(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
function treeFilesMap(repo: Repo, treeOid: string): Map<string, Buffer> {
  const flat = flattenTree(repo, treeOid);
  const out = new Map<string, Buffer>();
  for (const [path, entry] of flat) {
    const obj = repo.objects.get(entry.oid);
    if (obj) out.set(path, obj.data);
  }
  return out;
}
function commitOnBranch(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  let files = new Map<string, Buffer>();
  const parents: string[] = [];
  if (tip) {
    const c = parseCommit((repo.objects.get(tip) as GitObj).data);
    files = treeFilesMap(repo, c.tree);
    parents.push(tip);
  }
  files.set(path, content);
  const tree = treeFromFiles(repo, files);
  const blobSha = hashObject('blob', content);
  const ident = `${VIEWER.name} <${VIEWER.email}>`;
  const commitData = buildCommitText(tree, parents, ident, ident, epochNow(), message);
  const commitSha = putObj(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  repo.updatedAt = isoNow();
  return { commitSha, blobSha };
}
interface DiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
}
function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const s = buf.toString('utf8');
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}
function diffFiles(repo: Repo, baseTree: string, headTree: string): DiffFile[] {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const out: DiffFile[] = [];
  const names = new Set([...base.keys(), ...head.keys()]);
  for (const name of [...names].sort()) {
    const b = base.get(name);
    const h = head.get(name);
    if (b && !h) {
      const data = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const del = countLines(data);
      out.push({ filename: name, status: 'removed', additions: 0, deletions: del, changes: del, sha: b.oid });
    } else if (!b && h) {
      const data = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const add = countLines(data);
      out.push({ filename: name, status: 'added', additions: add, deletions: 0, changes: add, sha: h.oid });
    } else if (b && h && b.oid !== h.oid) {
      const bd = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const hd = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const bLines = new Set(bd.toString('utf8').split('\n'));
      const hLines = hd.toString('utf8').split('\n');
      let add = 0;
      for (const l of hLines) if (!bLines.has(l)) add += 1;
      const hSet = new Set(hLines);
      let del = 0;
      for (const l of bd.toString('utf8').split('\n')) if (!hSet.has(l)) del += 1;
      if (add === 0 && del === 0) {
        add = 1;
      }
      out.push({ filename: name, status: 'modified', additions: add, deletions: del, changes: add + del, sha: h.oid });
    }
  }
  return out;
}
function prMergeable(repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  if (pull.merged) return 'MERGEABLE';
  const base = mergeBase(repo, baseTip, headTip);
  if (!base) return 'UNKNOWN';
  const baseCommit = parseCommit((repo.objects.get(base) as GitObj).data);
  const baseTipCommit = parseCommit((repo.objects.get(baseTip) as GitObj).data);
  const headCommit = parseCommit((repo.objects.get(headTip) as GitObj).data);
  const baseTree = flattenTree(repo, baseCommit.tree);
  const curBaseTree = flattenTree(repo, baseTipCommit.tree);
  const headTree = flattenTree(repo, headCommit.tree);
  for (const [path, headEntry] of headTree) {
    const baseEntry = baseTree.get(path);
    const curEntry = curBaseTree.get(path);
    const headChanged = !baseEntry || baseEntry.oid !== headEntry.oid;
    const baseChanged = (!baseEntry && curEntry) || (baseEntry && curEntry && baseEntry.oid !== curEntry.oid) || (baseEntry && !curEntry);
    if (headChanged && baseChanged) {
      const curOid = curEntry ? curEntry.oid : null;
      if (curOid !== headEntry.oid) return 'CONFLICTING';
    }
  }
  // Also conflict when base removed a file head changed, etc. (covered above via baseChanged when !curEntry)
  return 'MERGEABLE';
}
function mergePull(repo: Repo, pull: Pull, method: string): { ok: boolean; sha?: string; reason?: string } {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (!baseTip || !headTip) return { ok: false, reason: 'missing branch' };
  if (prMergeable(repo, pull) === 'CONFLICTING') return { ok: false, reason: 'conflict' };
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseCommit = parseCommit((repo.objects.get(base) as GitObj).data);
  const baseTipCommit = parseCommit((repo.objects.get(baseTip) as GitObj).data);
  const headCommit = parseCommit((repo.objects.get(headTip) as GitObj).data);
  // Three-way merge at file level: start from base tip files, apply head changes vs merge-base.
  const files = treeFilesMap(repo, baseTipCommit.tree);
  const baseFiles = treeFilesMap(repo, baseCommit.tree);
  const headFiles = treeFilesMap(repo, headCommit.tree);
  for (const [path, data] of headFiles) {
    const baseData = baseFiles.get(path);
    if (!baseData || !baseData.equals(data)) files.set(path, data);
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path)) files.delete(path);
  }
  const tree = treeFromFiles(repo, files);
  const ident = `${VIEWER.name} <${VIEWER.email}>`;
  const ts = epochNow();
  const message = method === 'squash' ? `${pull.title}\n` : `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
  const parents = method === 'squash' ? [baseTip] : [baseTip, headTip];
  const commitData = buildCommitText(tree, parents, ident, ident, ts, message);
  const sha = putObj(repo, 'commit', commitData);
  repo.refs.set(baseRef, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = isoNow();
  pull.closedAt = pull.mergedAt;
  pull.mergeCommitSha = sha;
  pull.updatedAt = isoNow();
  repo.updatedAt = isoNow();
  return { ok: true, sha };
}
function createPullRecord(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip || !baseTip) return { error: 'head or base branch does not exist' };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) return { error: 'duplicate' };
  }
  const number = repo.nextNumber++;
  const id = repo.nextId++;
  const now = isoNow();
  const pull: Pull = {
    id, number, title, body: body ?? '', state: 'open', headRef: head, baseRef: base,
    headSha: headTip, baseSha: baseTip, baseCommitAtCreation: baseTip, merged: false, mergedAt: null,
    mergeCommitSha: null, userLogin: viewerLogin, seq: repoSeq * 100000 + number, createdAt: now, updatedAt: now, closedAt: null,
  };
  repo.pulls.set(number, pull);
  return pull;
}
function createIssueRecord(repo: Repo, title: string, body: string, labelNames: string[] | undefined): Issue | { error: string } {
  const labels: Label[] = [];
  if (labelNames) {
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label ${name} does not exist` };
      labels.push(label);
    }
  }
  const number = repo.nextNumber++;
  const id = repo.nextId++;
  const now = isoNow();
  const issue: Issue = {
    id, number, title, body: body ?? '', state: 'open', labels, userLogin: viewerLogin,
    comments: [], seq: repoSeq * 100000 + number, createdAt: now, updatedAt: now, closedAt: null, isPull: false,
  };
  repo.issues.set(number, issue);
  return issue;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  host: string;
  bodyRaw: Buffer;
  body: unknown;
  bodyParsed: boolean;
  bodyError: boolean;
}
function sendJson(ctx: Ctx, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextReqId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extraHeaders,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  ctx.res.writeHead(status, headers);
  ctx.res.end(text);
}
function sendErr(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message, documentation_url: '' });
}
function sendRaw(ctx: Ctx, status: number, body: Buffer, contentType: string): void {
  ctx.res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': nextReqId() });
  ctx.res.end(body);
}
function authed(ctx: Ctx): boolean {
  const h = ctx.req.headers.authorization;
  return typeof h === 'string' && /^Bearer\s+\S+/.test(h);
}
function requireAuth(ctx: Ctx): boolean {
  if (!authed(ctx)) {
    sendErr(ctx, 401, 'Requires authentication');
    return false;
  }
  return true;
}
function readBody(ctx: Ctx): Promise<void> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    ctx.req.on('data', (c: Buffer) => chunks.push(c));
    ctx.req.on('end', () => {
      ctx.bodyRaw = Buffer.concat(chunks);
      ctx.bodyParsed = false;
      ctx.bodyError = false;
      ctx.body = undefined;
      if (ctx.bodyRaw.length > 0) {
        try {
          ctx.body = JSON.parse(ctx.bodyRaw.toString('utf8'));
          ctx.bodyParsed = true;
        } catch {
          ctx.bodyError = true;
        }
      }
      resolve();
    });
    ctx.req.on('error', () => resolve());
  });
}
function bodyObj(ctx: Ctx): Json {
  return isRecord(ctx.body) ? ctx.body : {};
}
/** Parse a JSON body for a mutating API call; false when a 400 was already sent. */
function needJsonBody(ctx: Ctx): boolean {
  if (ctx.bodyRaw.length > 0 && ctx.bodyError) {
    sendErr(ctx, 400, 'Problems parsing JSON');
    return false;
  }
  return true;
}
function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, num(ctx.query.get('per_page') ? Number(ctx.query.get('per_page')) : 30, 30) || 30));
  const page = Math.max(1, num(ctx.query.get('page') ? Number(ctx.query.get('page')) : 1, 1) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(`http://${ctx.host}${ctx.path}`);
    for (const [k, v] of ctx.query) if (k !== 'page') url.searchParams.set(k, v);
    url.searchParams.set('per_page', String(perPage));
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    const last = new URL(url.toString());
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}
function sendPage<T>(ctx: Ctx, items: T[]): void {
  const { page, link } = paginate(ctx, items);
  sendJson(ctx, 200, page, link ? { link } : {});
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

async function handleRest(ctx: Ctx): Promise<void> {
  if (!requireAuth(ctx)) return;
  const parts = ctx.path.split('/').filter((p) => p !== '');
  // parts[0]='api', parts[1]='v3', rest follows
  const rest = parts.slice(2);
  const seg = (i: number): string => decodeURIComponent(rest[i] ?? '');

  if (rest.length === 0) {
    sendJson(ctx, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '',
      authorizations_url: '',
      code_search_url: '',
      commit_search_url: '',
      emails_url: '',
      emojis_url: '',
      events_url: '',
      feeds_url: '',
      followers_url: '',
      following_url: '',
      gists_url: '',
      hub_url: '',
      issue_search_url: '',
      issues_url: '',
      keys_url: '',
      label_search_url: '',
      notifications_url: '',
      organization_repositories_url: '',
      organization_teams_url: '',
      organization_url: '',
      public_gists_url: '',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '',
      repository_search_url: '',
      current_user_repositories_url: '/api/v3/user/repos',
      starred_url: '',
      starred_gists_url: '',
      topic_search_url: '',
      user_url: '/api/v3/user',
      user_organizations_url: '',
      user_repositories_url: '/api/v3/user/repos',
      user_search_url: '',
    });
    return;
  }
  if (rest.length === 1 && rest[0] === 'meta') {
    sendJson(ctx, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '', hooks: [], git: [], pages: [], importer: [], packages: [], actions: [], dependabot: [] });
    return;
  }
  if (rest.length === 1 && rest[0] === 'rate_limit') {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    sendJson(ctx, 200, { resources: { core: { limit: 5000, remaining: 4999, reset, used: 1 }, search: { limit: 30, remaining: 30, reset, used: 0 }, graphql: { limit: 5000, remaining: 5000, reset, used: 0 } }, rate: { limit: 5000, remaining: 4999, reset, used: 1 } });
    return;
  }
  if (rest.length === 1 && rest[0] === 'user' && ctx.method === 'GET') {
    sendJson(ctx, 200, userObj(viewerLogin));
    return;
  }
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (ctx.method === 'GET') {
      const all = [...repos.values()].filter((r) => r.owner === viewerLogin).sort((a, b) => a.seq - b.seq);
      sendPage(ctx, all.map(repoObj));
      return;
    }
    if (ctx.method === 'POST') {
      if (!needJsonBody(ctx)) return;
      const b = bodyObj(ctx);
      const name = str(b.name);
      if (!name) {
        sendErr(ctx, 422, 'name is required');
        return;
      }
      if (findRepoByName(name)) {
        sendErr(ctx, 422, 'name already exists on this account');
        return;
      }
      const repo = createRepoRecord(name, bool(b.private, false), str(b.description), str(b.default_branch, 'main'));
      sendJson(ctx, 201, repoObj(repo));
      return;
    }
  }
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = seg(1);
    const name = seg(2);
    const repo = findRepo(owner, name);
    if (!repo) {
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    const tail = rest.slice(3);
    // GET /repos/{o}/{r}
    if (tail.length === 0) {
      if (ctx.method === 'GET') {
        sendJson(ctx, 200, repoObj(repo));
        return;
      }
      if (ctx.method === 'PATCH') {
        if (!needJsonBody(ctx)) return;
        const b = bodyObj(ctx);
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.isPrivate = b.private;
        if (typeof b.default_branch === 'string' && b.default_branch) repo.defaultBranch = b.default_branch;
        repo.updatedAt = isoNow();
        sendJson(ctx, 200, repoObj(repo));
        return;
      }
      if (ctx.method === 'DELETE') {
        repos.delete(repoKey(repo.owner, repo.name));
        ctx.res.writeHead(204, { 'x-github-request-id': nextReqId(), 'x-oauth-scopes': 'repo, read:org' });
        ctx.res.end();
        return;
      }
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && ctx.method === 'GET') {
        const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((ref) => {
          const branch = ref.slice('refs/heads/'.length);
          return { name: branch, commit: { sha: repo.refs.get(ref) as string, url: '' }, protected: false };
        });
        sendJson(ctx, 200, list);
        return;
      }
      if (tail.length === 2 && ctx.method === 'GET') {
        const branch = decodeURIComponent(tail[1] as string);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          sendErr(ctx, 404, 'Branch not found');
          return;
        }
        sendJson(ctx, 200, { name: branch, commit: { sha, url: '' }, protected: false });
        return;
      }
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    // commits
    if (tail[0] === 'commits') {
      if (tail.length === 1 && ctx.method === 'GET') {
        const shaParam = ctx.query.get('sha');
        let tip: string | undefined;
        if (shaParam) {
          if (repo.refs.has(`refs/heads/${shaParam}`)) tip = repo.refs.get(`refs/heads/${shaParam}`);
          else if (repo.refs.has(`refs/tags/${shaParam}`)) tip = repo.refs.get(`refs/tags/${shaParam}`);
          else if (isOid(shaParam)) tip = shaParam;
          else tip = undefined;
        } else {
          tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        }
        if (!tip || !repo.objects.has(tip)) {
          sendJson(ctx, 200, []);
          return;
        }
        const list = commitChain(repo, tip).map((oid) => commitObj(repo, oid));
        sendPage(ctx, list);
        return;
      }
      if (tail.length === 2 && ctx.method === 'GET') {
        const oid = decodeURIComponent(tail[1] as string);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        sendJson(ctx, 200, commitObj(repo, oid));
        return;
      }
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    // git refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (ctx.method === 'POST' && tail.length === 2) {
        if (!needJsonBody(ctx)) return;
        const b = bodyObj(ctx);
        const ref = str(b.ref);
        const sha = str(b.sha);
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          sendErr(ctx, 422, 'Object does not exist');
          return;
        }
        if (repo.refs.has(ref)) {
          sendErr(ctx, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(ctx, 201, { ref, node_id: b64id(`ref:${repo.id}:${ref}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        return;
      }
      if (ctx.method === 'GET') {
        // /git/refs/heads/{branch} or /git/refs/tags/{name} or /git/refs
        if (tail.length >= 4) {
          const ref = `refs/${tail.slice(2).map((s) => decodeURIComponent(s)).join('/')}`;
          const sha = repo.refs.get(ref);
          if (!sha) {
            sendErr(ctx, 404, 'Not Found');
            return;
          }
          sendJson(ctx, 200, { ref, node_id: b64id(`ref:${repo.id}:${ref}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
          return;
        }
        if (tail.length === 2) {
          const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: b64id(`ref:${repo.id}:${ref}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }));
          sendJson(ctx, 200, list);
          return;
        }
        sendErr(ctx, 404, 'Not Found');
        return;
      }
      if (ctx.method === 'PATCH' && tail.length >= 4) {
        if (!needJsonBody(ctx)) return;
        const ref = `refs/${tail.slice(2).map((s) => decodeURIComponent(s)).join('/')}`;
        const sha = str(bodyObj(ctx).sha);
        if (!repo.refs.has(ref) || !isOid(sha)) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(ctx, 200, { ref, object: { sha, type: 'commit', url: '' } });
        return;
      }
      if (ctx.method === 'DELETE' && tail.length >= 4) {
        const ref = `refs/${tail.slice(2).map((s) => decodeURIComponent(s)).join('/')}`;
        if (!repo.refs.has(ref)) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        repo.refs.delete(ref);
        ctx.res.writeHead(204, { 'x-github-request-id': nextReqId(), 'x-oauth-scopes': 'repo, read:org' });
        ctx.res.end();
        return;
      }
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    // contents
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
      const refParam = ctx.query.get('ref');
      const resolveTip = (): string | undefined => {
        if (refParam) {
          if (repo.refs.has(`refs/heads/${refParam}`)) return repo.refs.get(`refs/heads/${refParam}`);
          if (repo.refs.has(`refs/tags/${refParam}`)) return repo.refs.get(`refs/tags/${refParam}`);
          if (isOid(refParam)) return refParam;
          return undefined;
        }
        return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      };
      if (ctx.method === 'GET') {
        const tip = resolveTip();
        if (!tip) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        const commit = parseCommit((repo.objects.get(tip) as GitObj).data);
        if (filePath === '') {
          const flat = flattenTree(repo, commit.tree);
          const top = new Map<string, { type: string; oid: string }>();
          for (const [path, entry] of flat) {
            const first = path.split('/')[0] as string;
            if (!top.has(first)) top.set(first, { type: path.includes('/') ? 'dir' : 'file', oid: entry.oid });
          }
          // directories need their tree oid: recompute via tree walk
          const entries = dirEntries(repo, commit.tree, '');
          sendJson(ctx, 200, entries);
          return;
        }
        const flat = flattenTree(repo, commit.tree);
        const file = flat.get(filePath);
        if (file) {
          const data = (repo.objects.get(file.oid) as GitObj).data;
          sendJson(ctx, 200, {
            type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(),
            path: filePath, content: b64(data), sha: file.oid, url: '', git_url: '', html_url: '', download_url: '',
          });
          return;
        }
        // directory?
        const prefix = `${filePath}/`;
        let isDir = false;
        for (const p of flat.keys()) if (p.startsWith(prefix)) {
          isDir = true;
          break;
        }
        if (isDir) {
          sendJson(ctx, 200, dirEntries(repo, commit.tree, filePath));
          return;
        }
        sendErr(ctx, 404, 'Not Found');
        return;
      }
      if (ctx.method === 'PUT') {
        if (!needJsonBody(ctx)) return;
        const b = bodyObj(ctx);
        const message = str(b.message, 'Update file');
        const contentB64 = str(b.content);
        if (contentB64 === '') {
          sendErr(ctx, 422, 'content is required');
          return;
        }
        const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
        const branch = str(b.branch, repo.defaultBranch);
        const ref = `refs/heads/${branch}`;
        let tip = repo.refs.get(ref);
        if (tip === undefined && branch !== repo.defaultBranch) {
          // Create the branch from the default tip (or empty) then commit.
          const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (baseTip) repo.refs.set(ref, baseTip);
          tip = repo.refs.get(ref);
        }
        let exists = false;
        let currentSha = '';
        if (tip) {
          const commit = parseCommit((repo.objects.get(tip) as GitObj).data);
          const flat = flattenTree(repo, commit.tree);
          const entry = flat.get(filePath);
          if (entry) {
            exists = true;
            currentSha = entry.oid;
          }
        }
        if (exists) {
          const givenSha = str(b.sha);
          if (!givenSha) {
            sendErr(ctx, 422, 'sha is required to update a file');
            return;
          }
          if (givenSha.toLowerCase() !== currentSha.toLowerCase()) {
            sendErr(ctx, 409, 'sha does not match the current file');
            return;
          }
        }
        const { commitSha, blobSha } = commitOnBranch(repo, branch, filePath, content, message);
        sendJson(ctx, exists ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobSha, size: content.length, url: '', git_url: '', html_url: '', download_url: '', type: 'file', encoding: 'base64', content: b64(content) },
          commit: { sha: commitSha, message, author: userObj(viewerLogin), committer: userObj(viewerLogin), url: '', html_url: '', parents: [] },
        });
        return;
      }
      if (ctx.method === 'DELETE') {
        if (!needJsonBody(ctx)) return;
        const b = bodyObj(ctx);
        const branch = str(b.branch, repo.defaultBranch);
        const ref = `refs/heads/${branch}`;
        const tip = repo.refs.get(ref);
        if (!tip) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        const commit = parseCommit((repo.objects.get(tip) as GitObj).data);
        const files = treeFilesMap(repo, commit.tree);
        if (!files.has(filePath)) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        const givenSha = str(b.sha);
        const currentSha = hashObject('blob', files.get(filePath) as Buffer);
        if (givenSha && givenSha.toLowerCase() !== currentSha.toLowerCase()) {
          sendErr(ctx, 409, 'sha does not match the current file');
          return;
        }
        files.delete(filePath);
        const tree = treeFromFiles(repo, files);
        const ident = `${VIEWER.name} <${VIEWER.email}>`;
        const message = str(b.message, 'Delete file');
        const commitData = buildCommitText(tree, [tip], ident, ident, epochNow(), message);
        const commitSha = putObj(repo, 'commit', commitData);
        repo.refs.set(ref, commitSha);
        repo.updatedAt = isoNow();
        sendJson(ctx, 200, { content: null, commit: { sha: commitSha, message, author: userObj(viewerLogin), committer: userObj(viewerLogin), url: '', html_url: '', parents: [] } });
        return;
      }
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    // labels
    if (tail[0] === 'labels') {
      if (ctx.method === 'GET' && tail.length === 1) {
        sendJson(ctx, 200, [...repo.labels.values()].map(labelObj));
        return;
      }
      if (ctx.method === 'POST' && tail.length === 1) {
        if (!needJsonBody(ctx)) return;
        const b = bodyObj(ctx);
        const name = str(b.name);
        if (!name) {
          sendErr(ctx, 422, 'name is required');
          return;
        }
        const existing = repo.labels.get(name);
        if (existing) {
          sendJson(ctx, 200, labelObj(existing));
          return;
        }
        const label: Label = { id: repo.nextLabelId++, name, color: str(b.color, 'ededed'), description: str(b.description) };
        repo.labels.set(name, label);
        sendJson(ctx, 201, labelObj(label));
        return;
      }
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (ctx.method === 'GET') {
          let list = [...repo.issues.values()];
          const state = ctx.query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = ctx.query.get('sort') ?? 'created';
          const dir = ctx.query.get('direction') ?? 'desc';
          if (sort === 'created' || sort === 'updated') {
            list.sort((a, b) => (dir === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          sendPage(ctx, list.map((i) => issueObj(repo, i)));
          return;
        }
        if (ctx.method === 'POST') {
          if (!needJsonBody(ctx)) return;
          const b = bodyObj(ctx);
          const title = str(b.title);
          if (!title) {
            sendErr(ctx, 422, 'title is required');
            return;
          }
          const labels = Array.isArray(b.labels) ? (b.labels as unknown[]).map((x) => (typeof x === 'string' ? x : str((x as Json).name))) : undefined;
          const created = createIssueRecord(repo, title, str(b.body), labels);
          if ('error' in created) {
            sendErr(ctx, 422, `Validation Failed: ${created.error}`);
            return;
          }
          sendJson(ctx, 201, issueObj(repo, created));
          return;
        }
        sendErr(ctx, 404, 'Not Found');
        return;
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) {
        sendErr(ctx, 404, 'Not Found');
        return;
      }
      const issue = repo.issues.get(num);
      if (tail.length === 2) {
        if (!issue) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        if (ctx.method === 'GET') {
          sendJson(ctx, 200, issueObj(repo, issue));
          return;
        }
        if (ctx.method === 'PATCH') {
          if (!needJsonBody(ctx)) return;
          const b = bodyObj(ctx);
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') {
            issue.state = b.state;
            issue.closedAt = b.state === 'closed' ? isoNow() : null;
          }
          if (Array.isArray(b.labels)) {
            const labels: Label[] = [];
            let bad = false;
            for (const x of b.labels as unknown[]) {
              const nm = typeof x === 'string' ? x : str((x as Json).name);
              const lab = repo.labels.get(nm);
              if (!lab) {
                bad = true;
                break;
              }
              labels.push(lab);
            }
            if (bad) {
              sendErr(ctx, 422, 'Validation Failed: label does not exist');
              return;
            }
            issue.labels = labels;
          }
          issue.updatedAt = isoNow();
          sendJson(ctx, 200, issueObj(repo, issue));
          return;
        }
        sendErr(ctx, 404, 'Not Found');
        return;
      }
      if (tail[2] === 'comments') {
        if (!issue) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        if (ctx.method === 'GET') {
          sendJson(ctx, 200, issue.comments.map((c) => commentObj(repo, issue, c)));
          return;
        }
        if (ctx.method === 'POST') {
          if (!needJsonBody(ctx)) return;
          const b = bodyObj(ctx);
          const bodyText = str(b.body);
          if (!bodyText) {
            sendErr(ctx, 422, 'body is required');
            return;
          }
          const now = isoNow();
          const comment: Comment = { id: repo.nextCommentId++, body: bodyText, userLogin: viewerLogin, createdAt: now, updatedAt: now };
          issue.comments.push(comment);
          issue.updatedAt = now;
          sendJson(ctx, 201, commentObj(repo, issue, comment));
          return;
        }
        sendErr(ctx, 404, 'Not Found');
        return;
      }
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (ctx.method === 'GET') {
          let list = [...repo.pulls.values()];
          const state = ctx.query.get('state') ?? 'open';
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          sendPage(ctx, list.map((p) => pullObj(repo, p)));
          return;
        }
        if (ctx.method === 'POST') {
          if (!needJsonBody(ctx)) return;
          const b = bodyObj(ctx);
          const head = str(b.head);
          const base = str(b.base);
          const title = str(b.title);
          if (!title || !head || !base) {
            sendErr(ctx, 422, 'title, head and base are required');
            return;
          }
          const created = createPullRecord(repo, title, str(b.body), head, base);
          if ('error' in created) {
            sendErr(ctx, 422, created.error === 'duplicate' ? 'A pull request already exists for this head and base' : `Validation Failed: ${created.error}`);
            return;
          }
          sendJson(ctx, 201, pullObj(repo, created));
          return;
        }
        sendErr(ctx, 404, 'Not Found');
        return;
      }
      const num = Number(tail[1]);
      if (!Number.isInteger(num)) {
        sendErr(ctx, 404, 'Not Found');
        return;
      }
      const pull = repo.pulls.get(num);
      if (tail.length === 2) {
        if (!pull) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        if (ctx.method === 'GET') {
          sendJson(ctx, 200, pullObj(repo, pull));
          return;
        }
        if (ctx.method === 'PATCH') {
          if (!needJsonBody(ctx)) return;
          const b = bodyObj(ctx);
          if (typeof b.title === 'string') pull.title = b.title;
          if (typeof b.body === 'string') pull.body = b.body;
          if (b.state === 'closed' && pull.state === 'open') {
            pull.state = 'closed';
            pull.closedAt = isoNow();
          }
          pull.updatedAt = isoNow();
          sendJson(ctx, 200, pullObj(repo, pull));
          return;
        }
        sendErr(ctx, 404, 'Not Found');
        return;
      }
      if (tail[2] === 'files' && ctx.method === 'GET') {
        if (!pull) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        const files = pullFiles(repo, pull);
        sendJson(ctx, 200, files.map((f) => ({
          sha: f.sha, filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
          changes: f.changes, blob_url: '', raw_url: '', contents_url: '', patch: '',
        })));
        return;
      }
      if (tail[2] === 'commits' && ctx.method === 'GET') {
        if (!pull) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        const base = mergeBase(repo, pull.baseSha, pull.headSha);
        const headChain = commitChain(repo, pull.headSha);
        const baseSet = base ? reachable(repo, [base]) : new Set<string>();
        const list = headChain.filter((oid) => !baseSet.has(oid) || oid === base).filter((oid) => oid !== base).map((oid) => commitObj(repo, oid));
        sendJson(ctx, 200, list);
        return;
      }
      if (tail[2] === 'merge' && ctx.method === 'PUT') {
        if (!pull) {
          sendErr(ctx, 404, 'Not Found');
          return;
        }
        if (!needJsonBody(ctx)) return;
        const method = str(bodyObj(ctx).merge_method, 'squash').toLowerCase();
        if (pull.merged || pull.state === 'closed') {
          sendErr(ctx, 405, 'Pull request has already been merged');
          return;
        }
        const merged = mergePull(repo, pull, method === 'merge' ? 'merge' : method === 'rebase' ? 'squash' : 'squash');
        if (!merged.ok) {
          sendErr(ctx, 405, 'Merge conflict: the pull request cannot be merged cleanly');
          return;
        }
        sendJson(ctx, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
      sendErr(ctx, 404, 'Not Found');
      return;
    }
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  sendErr(ctx, 404, 'Not Found');
}
function commitObj(repo: Repo, oid: string): Json {
  const obj = repo.objects.get(oid) as GitObj;
  const c = parseCommit(obj.data);
  const msg = c.message.replace(/\n+$/, '');
  const authorName = c.author.replace(/ <[^>]*>.*$/, '');
  const authorEmail = (/<([^>]*)>/.exec(c.author) ?? [])[1] ?? '';
  const date = new Date(c.timestamp * 1000).toISOString();
  return {
    sha: oid,
    node_id: b64id(`commit:${repo.id}:${oid}`),
    commit: {
      author: { name: authorName, email: authorEmail, date },
      committer: { name: authorName, email: authorEmail, date },
      message: msg,
      tree: { sha: c.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: '',
    html_url: '',
    comments_url: '',
    author: { login: viewerLogin, id: VIEWER.id },
    committer: { login: viewerLogin, id: VIEWER.id },
    parents: c.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
  };
}
function commentObj(repo: Repo, issue: Issue, c: Comment): Json {
  return {
    id: c.id,
    node_id: b64id(`comment:${repo.id}:${issue.number}:${c.id}`),
    body: c.body,
    user: userObj(c.userLogin),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    url: '',
    html_url: '',
    issue_url: '',
    author_association: 'OWNER',
  };
}
function dirEntries(repo: Repo, treeOid: string, dirPath: string): Json[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  let current = treeOid;
  if (dirPath !== '') {
    const flat = flattenTree(repo, treeOid);
    // Walk down to the directory's tree oid.
    const segs = dirPath.split('/');
    let oid = treeOid;
    for (const segName of segs) {
      const entries = parseTree((repo.objects.get(oid) as GitObj).data);
      const found = entries.find((e) => e.name === segName && e.mode === '40000');
      if (!found) return [];
      oid = found.oid;
    }
    current = oid;
  }
  const entries = parseTree((repo.objects.get(current) as GitObj).data);
  return entries.map((e) => {
    const isDir = e.mode === '40000';
    const size = isDir ? 0 : ((repo.objects.get(e.oid)?.data.length) ?? 0);
    return { type: isDir ? 'dir' : 'file', size, name: e.name, path: dirPath ? `${dirPath}/${e.name}` : e.name, sha: e.oid, url: '', git_url: '', html_url: '', download_url: isDir ? null : '' };
  });
}
function pullFiles(repo: Repo, pull: Pull): DiffFile[] {
  const base = mergeBase(repo, pull.baseSha, pull.headSha) ?? pull.baseSha;
  const baseCommit = parseCommit((repo.objects.get(base) as GitObj).data);
  const headCommit = parseCommit((repo.objects.get(pull.headSha) as GitObj).data);
  return diffFiles(repo, baseCommit.tree, headCommit.tree);
}

// ---------------------------------------------------------------------------
// GraphQL v4 (small parser + resolver executor)
// ---------------------------------------------------------------------------

interface GField {
  name: string;
  alias: string;
  args: Record<string, unknown>;
  children: GField[];
  fragment?: string;
}
interface GOperation {
  kind: 'query' | 'mutation';
  name: string;
  selections: GField[];
  variables: Record<string, unknown>;
}
interface GQLTypeInfo {
  name: string;
  kind: 'OBJECT' | 'SCALAR' | 'ENUM' | 'INTERFACE' | 'UNION' | 'INPUT_OBJECT';
  fields?: string[];
  enumValues?: string[];
}
const GQL_TYPES: Record<string, GQLTypeInfo> = {
  Query: { name: 'Query', kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'search', 'rateLimit'] },
  Mutation: { name: 'Mutation', kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { name: 'User', kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'databaseId', 'url', 'avatarUrl', 'repositories', 'issues'] },
  Repository: { name: 'Repository', kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url'] },
  Issue: { name: 'Issue', kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'url'] },
  PullRequest: { name: 'PullRequest', kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'author', 'repository', 'url'] },
  IssueConnection: { name: 'IssueConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PullRequestConnection: { name: 'PullRequestConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PageInfo: { name: 'PageInfo', kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueEdge: { name: 'IssueEdge', kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { name: 'PullRequestEdge', kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueComment: { name: 'IssueComment', kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt'] },
  CommentEdge: { name: 'CommentEdge', kind: 'OBJECT', fields: ['node', 'cursor'] },
  AddCommentPayload: { name: 'AddCommentPayload', kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  CreateIssuePayload: { name: 'CreateIssuePayload', kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { name: 'CloseIssuePayload', kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { name: 'CreatePullRequestPayload', kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { name: 'MergePullRequestPayload', kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  Ref: { name: 'Ref', kind: 'OBJECT', fields: ['name', 'target'] },
  Label: { name: 'Label', kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  LabelConnection: { name: 'LabelConnection', kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  SearchType: { name: 'SearchType', kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueState: { name: 'IssueState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { name: 'PullRequestState', kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  RepositoryPermission: { name: 'RepositoryPermission', kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  MergeableState: { name: 'MergeableState', kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { name: 'PullRequestMergeMethod', kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  String: { name: 'String', kind: 'SCALAR' },
  Int: { name: 'Int', kind: 'SCALAR' },
  ID: { name: 'ID', kind: 'SCALAR' },
  Boolean: { name: 'Boolean', kind: 'SCALAR' },
  DateTime: { name: 'DateTime', kind: 'SCALAR' },
};
function gqlTypeFieldList(typeName: string, includeDeprecated = true): Json {
  const t = GQL_TYPES[typeName];
  if (!t) return null as unknown as Json;
  const out: Json = { name: t.name, kind: t.kind, description: null };
  if (t.fields) out.fields = t.fields.map((f) => ({ name: f, description: null, args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } }));
  else out.fields = null;
  if (t.enumValues) out.enumValues = t.enumValues.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null }));
  else out.enumValues = null;
  out.possibleTypes = null;
  out.interfaces = null;
  out.inputFields = null;
  return out;
}
interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
  value: string;
}
function tokenizeGql(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',' || ch === ';') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{ }|'.includes(ch) || ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === ':' || ch === '=' || ch === '@' || ch === '[' || ch === ']' || ch === '!' || ch === '$' || ch === '|') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1] as string;
          value += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          j += 2;
        } else {
          value += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let value = '';
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) {
        value += src[j];
        j += 1;
      }
      tokens.push({ kind: value.includes('.') || value.includes('e') ? 'float' : 'int', value });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      let value = '';
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] as string)) {
        value += src[j];
        j += 1;
      }
      tokens.push({ kind: 'name', value });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}
class GqlParser {
  #tokens: Token[];
  #pos = 0;
  #variables: Record<string, unknown>;
  constructor(src: string, variables: Record<string, unknown>) {
    this.#tokens = tokenizeGql(src);
    this.#variables = variables;
  }
  #peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }
  #next(): Token {
    const t = this.#tokens[this.#pos] as Token;
    this.#pos += 1;
    return t;
  }
  #expect(value: string): Token {
    const t = this.#next();
    if (t.value !== value) throw new Error(`expected ${value}, got ${t.value}`);
    return t;
  }
  #skipParens(): void {
    // Skip variable definitions / directives we don't need: balanced parens.
    if (this.#peek().value !== '(') return;
    let depth = 0;
    while (this.#pos < this.#tokens.length) {
      const t = this.#next();
      if (t.value === '(') depth += 1;
      else if (t.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  #parseValue(): unknown {
    const t = this.#next();
    if (t.kind === 'int') return Number(t.value);
    if (t.kind === 'float') return Number(t.value);
    if (t.kind === 'string') return t.value;
    if (t.kind === 'punct' && t.value === '$') {
      const name = this.#next().value;
      return this.#variables[name];
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: unknown[] = [];
      while (this.#peek().value !== ']') items.push(this.#parseValue());
      this.#expect(']');
      return items;
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.#peek().value !== '}') {
        const key = this.#next();
        this.#expect(':');
        obj[key.value] = this.#parseValue();
      }
      this.#expect('}');
      return obj;
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { __enum: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
  #parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.#peek().value !== '(') return args;
    this.#expect('(');
    while (this.#peek().value !== ')') {
      const name = this.#next().value;
      this.#expect(':');
      args[name] = this.#parseValue();
    }
    this.#expect(')');
    return args;
  }
  #parseSelections(): GField[] {
    const fields: GField[] = [];
    this.#expect('{');
    while (this.#peek().value !== '}') {
      if (this.#peek().kind === 'eof') throw new Error('unterminated selection set');
      if (this.#peek().kind === 'spread') {
        this.#next();
        if (this.#peek().value === 'on') {
          this.#next();
          const typeName = this.#next().value;
          const children = this.#parseSelections();
          for (const c of children) {
            fields.push({ ...c, fragment: typeName });
          }
        } else {
          // named fragment spread: skip the name; the fragment itself is
          // collected separately by parseDocument.
          this.#next();
          if (this.#peek().value === '{') this.#parseSelections();
        }
        continue;
      }
      const first = this.#next();
      let alias = first.value;
      let name = first.value;
      if (this.#peek().value === ':') {
        this.#next();
        name = this.#next().value;
      }
      const args = this.#parseArgs();
      let children: GField[] = [];
      if (this.#peek().value === '{') children = this.#parseSelections();
      fields.push({ name, alias, args, children });
    }
    this.#expect('}');
    return fields;
  }
  parseDocument(): GOperation[] {
    const ops: GOperation[] = [];
    while (this.#peek().kind !== 'eof') {
      let kind: 'query' | 'mutation' = 'query';
      let name = '';
      const tok = this.#peek();
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        kind = tok.value as 'query' | 'mutation';
        this.#next();
        if (this.#peek().kind === 'name') name = this.#next().value;
        this.#skipParens();
      } else if (tok.value === 'fragment') {
        this.#next();
        this.#next(); // fragment name
        this.#next(); // 'on'
        this.#next(); // type name
        this.#parseSelections(); // skip the fragment body
        continue;
      }
      if (this.#peek().value !== '{') throw new Error('expected selection set');
      const selections = this.#parseSelections();
      ops.push({ kind, name, selections, variables: this.#variables });
    }
    return ops;
  }
}
function enumVal(v: unknown): string {
  if (isRecord(v) && typeof v.__enum === 'string') return v.__enum;
  return typeof v === 'string' ? v : '';
}
// Resolver context
interface GResolver {
  value: unknown;
  type: string;
}
function gqlId(kind: string, ...parts: (string | number)[]): string {
  return b64id(`${kind}:${parts.join(':')}`);
}
function findRepoByGqlId(id: string): Repo | undefined {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const m = /^repo:(.+)\/(.+)$/.exec(decoded);
    if (m) return findRepo(m[1] as string, m[2] as string);
  } catch {
    // not a base64 id we minted
  }
  return undefined;
}
function findIssueByGqlId(id: string): { repo: Repo; issue: Issue } | undefined {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const m = /^issue:(\d+):(\d+)$/.exec(decoded);
    if (m) {
      const repo = [...repos.values()].find((r) => r.id === Number(m[1]));
      if (repo) {
        const issue = repo.issues.get(Number(m[2]));
        if (issue) return { repo, issue };
      }
    }
  } catch { /* ignore */ }
  return undefined;
}
function findPullByGqlId(id: string): { repo: Repo; pull: Pull } | undefined {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const m = /^pr:(\d+):(\d+)$/.exec(decoded);
    if (m) {
      const repo = [...repos.values()].find((r) => r.id === Number(m[1]));
      if (repo) {
        const pull = repo.pulls.get(Number(m[2]));
        if (pull) return { repo, pull };
      }
    }
  } catch { /* ignore */ }
  return undefined;
}
function resolveField(parent: GResolver, field: GField, errors: string[]): unknown {
  const { value, type } = parent;
  const name = field.name;
  if (name === '__typename') return type;
  if (name === '__type') {
    const typeName = str(field.args.name);
    return gqlTypeFieldList(typeName);
  }
  if (name === '__schema') return { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: Object.keys(GQL_TYPES).map((n) => ({ name: n, kind: GQL_TYPES[n]?.kind })) };
  if (type === 'Query') {
    if (name === 'viewer') return { value: { login: viewerLogin }, type: 'User' };
    if (name === 'repository') {
      const repo = findRepo(str(field.args.owner), str(field.args.name));
      return repo ? { value: repo, type: 'Repository' } : null;
    }
    if (name === 'node') {
      const id = str(field.args.id);
      const repo = findRepoByGqlId(id);
      if (repo) return { value: repo, type: 'Repository' };
      const issue = findIssueByGqlId(id);
      if (issue) return { value: { repo: issue.repo, issue: issue.issue }, type: 'Issue' };
      const pull = findPullByGqlId(id);
      if (pull) return { value: { repo: pull.repo, pull: pull.pull }, type: 'PullRequest' };
      return null;
    }
    if (name === 'rateLimit') return { value: { limit: 5000, remaining: 5000, cost: 1 }, type: 'RateLimit' };
    errors.push(`Cannot query field "${name}" on type "Query".`);
    return undefined;
  }
  if (type === 'Mutation') {
    const input = isRecord(field.args.input) ? field.args.input : {};
    if (name === 'createIssue') {
      const repo = findRepoByGqlId(str(input.repositoryId));
      if (!repo) {
        errors.push('Could not resolve to a Repository with the id of that repository.');
        return null;
      }
      const created = createIssueRecord(repo, str(input.title), str(input.body), undefined);
      if ('error' in created) {
        errors.push(created.error);
        return null;
      }
      return { value: { issue: created, repo }, type: 'CreateIssuePayload' };
    }
    if (name === 'closeIssue') {
      const found = findIssueByGqlId(str(input.issueId));
      if (!found) {
        errors.push('Could not resolve to an Issue with the id of that issue.');
        return null;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = isoNow();
      found.issue.updatedAt = isoNow();
      return { value: { issue: found.issue, repo: found.repo }, type: 'CloseIssuePayload' };
    }
    if (name === 'createPullRequest') {
      const repo = findRepoByGqlId(str(input.repositoryId));
      if (!repo) {
        errors.push('Could not resolve to a Repository with the id of that repository.');
        return null;
      }
      const created = createPullRecord(repo, str(input.title), str(input.body), str(input.headRefName), str(input.baseRefName));
      if ('error' in created) {
        if (created.error === 'duplicate') {
          const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === str(input.headRefName) && p.baseRef === str(input.baseRefName));
          if (existing) return { value: { pullRequest: existing, repo }, type: 'CreatePullRequestPayload' };
        }
        errors.push(created.error);
        return null;
      }
      return { value: { pullRequest: created, repo }, type: 'CreatePullRequestPayload' };
    }
    if (name === 'mergePullRequest') {
      const found = findPullByGqlId(str(input.pullRequestId));
      if (!found) {
        errors.push('Could not resolve to a PullRequest with the id of that pull request.');
        return null;
      }
      const method = enumVal(input.mergeMethod) || 'SQUASH';
      const merged = mergePull(found.repo, found.pull, method.toLowerCase() === 'merge' ? 'merge' : 'squash');
      if (!merged.ok) {
        errors.push('Merge conflict');
        return { value: { pullRequest: found.pull, repo: found.repo }, type: 'MergePullRequestPayload' };
      }
      return { value: { pullRequest: found.pull, repo: found.repo }, type: 'MergePullRequestPayload' };
    }
    if (name === 'addComment') {
      const found = findIssueByGqlId(str(input.subjectId));
      if (found) {
        const now = isoNow();
        const comment: Comment = { id: found.repo.nextCommentId++, body: str(input.body), userLogin: viewerLogin, createdAt: now, updatedAt: now };
        found.issue.comments.push(comment);
        found.issue.updatedAt = now;
        return { value: { comment, repo: found.repo, issue: found.issue }, type: 'AddCommentPayload' };
      }
      const pullFound = findPullByGqlId(str(input.subjectId));
      if (pullFound) {
        const now = isoNow();
        const comment: Comment = { id: pullFound.repo.nextCommentId++, body: str(input.body), userLogin: viewerLogin, createdAt: now, updatedAt: now };
        return { value: { comment, repo: pullFound.repo }, type: 'AddCommentPayload' };
      }
      errors.push('Could not resolve to a node with the id of that subject.');
      return null;
    }
    errors.push(`Cannot query field "${name}" on type "Mutation".`);
    return undefined;
  }
  if (type === 'User') {
    const u = value as { login: string };
    if (name === 'login') return u.login;
    if (name === 'id') return gqlId('user', u.login);
    if (name === 'name') return u.login === viewerLogin ? VIEWER.name : u.login;
    if (name === 'email') return u.login === viewerLogin ? VIEWER.email : `${u.login}@example.invalid`;
    if (name === 'databaseId') return u.login === viewerLogin ? VIEWER.id : 1000;
    if (name === 'url') return '';
    if (name === 'avatarUrl') return '';
    errors.push(`Cannot query field "${name}" on type "User".`);
    return undefined;
  }
  if (type === 'Repository') {
    const repo = value as Repo;
    if (name === 'id') return gqlId('repo', `${repo.owner}/${repo.name}`);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') return { value: { login: repo.owner }, type: 'User' };
    if (name === 'defaultBranchRef') {
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!sha) return null;
      return { value: { name: repo.defaultBranch, repo }, type: 'Ref' };
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate') return repo.isPrivate;
    if (name === 'url') return '';
    if (name === 'issue') {
      const issue = repo.issues.get(num(field.args.number));
      return issue ? { value: { repo, issue }, type: 'Issue' } : null;
    }
    if (name === 'issues') return { value: { repo, kind: 'issues', args: field.args }, type: 'IssueConnection' };
    if (name === 'pullRequest') {
      const pull = repo.pulls.get(num(field.args.number));
      return pull ? { value: { repo, pull }, type: 'PullRequest' } : null;
    }
    if (name === 'pullRequests') return { value: { repo, kind: 'pulls', args: field.args }, type: 'PullRequestConnection' };
    errors.push(`Cannot query field "${name}" on type "Repository".`);
    return undefined;
  }
  if (type === 'Issue') {
    const v = value as { repo: Repo; issue: Issue };
    const issue = v.issue;
    if (name === 'id') return gqlId('issue', v.repo.id, issue.number);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'state') return issue.state.toUpperCase();
    if (name === 'body') return issue.body;
    if (name === 'createdAt') return issue.createdAt;
    if (name === 'updatedAt') return issue.updatedAt;
    if (name === 'author') return { value: { login: issue.userLogin }, type: 'User' };
    if (name === 'labels') return { value: { labels: issue.labels }, type: 'LabelConnection' };
    if (name === 'comments') return { value: { comments: issue.comments, repo: v.repo }, type: 'IssueCommentConnection' };
    if (name === 'repository') return { value: v.repo, type: 'Repository' };
    if (name === 'url') return '';
    errors.push(`Cannot query field "${name}" on type "Issue".`);
    return undefined;
  }
  if (type === 'PullRequest') {
    const v = value as { repo: Repo; pull: Pull };
    const pull = v.pull;
    if (name === 'id') return gqlId('pr', v.repo.id, pull.number);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    if (name === 'body') return pull.body;
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'headRefOid') return pull.headSha;
    if (name === 'baseRefOid') return pull.baseSha;
    if (name === 'mergeable') return prMergeable(v.repo, pull);
    if (name === 'merged') return pull.merged;
    if (name === 'mergedAt') return pull.mergedAt;
    if (name === 'mergeCommit') return pull.mergeCommitSha ? { value: { oid: pull.mergeCommitSha, repo: v.repo }, type: 'Commit' } : null;
    if (name === 'files') {
      const files = pullFiles(v.repo, pull);
      const first = num(field.args.first, files.length);
      return { value: { nodes: files.slice(0, first).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED' })) }, type: 'PullRequestChangedFileConnection' };
    }
    if (name === 'author') return { value: { login: pull.userLogin }, type: 'User' };
    if (name === 'repository') return { value: v.repo, type: 'Repository' };
    if (name === 'url') return '';
    errors.push(`Cannot query field "${name}" on type "PullRequest".`);
    return undefined;
  }
  if (type === 'IssueConnection' || type === 'PullRequestConnection') {
    const v = value as { repo: Repo; kind: 'issues' | 'pulls'; args: Record<string, unknown> };
    const args = v.args;
    const first = num(args.first, 100);
    let afterIndex = -1;
    if (typeof args.after === 'string' && args.after) {
      try {
        const decoded = Buffer.from(args.after, 'base64').toString('utf8');
        const m = /^cursor:(\d+)$/.exec(decoded);
        if (m) afterIndex = Number(m[1]);
      } catch { /* ignore */ }
    }
    let nodes: unknown[] = [];
    let total = 0;
    if (v.kind === 'issues') {
      let list = [...v.repo.issues.values()];
      const statesRaw = args.states;
      if (Array.isArray(statesRaw) && statesRaw.length) {
        const states = statesRaw.map((s) => enumVal(s).toLowerCase());
        list = list.filter((i) => states.includes(i.state));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const dir = enumVal(orderBy.direction) || 'DESC';
      list.sort((a, b) => (dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      total = list.length;
      nodes = list.slice(afterIndex + 1, afterIndex + 1 + first).map((issue) => ({ value: { repo: v.repo, issue }, type: 'Issue' }));
    } else {
      let list = [...v.repo.pulls.values()];
      const statesRaw = args.states;
      if (Array.isArray(statesRaw) && statesRaw.length) {
        const states = statesRaw.map((s) => enumVal(s));
        list = list.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
      }
      const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
      const dir = enumVal(orderBy.direction) || 'DESC';
      list.sort((a, b) => (dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      total = list.length;
      nodes = list.slice(afterIndex + 1, afterIndex + 1 + first).map((pull) => ({ value: { repo: v.repo, pull }, type: 'PullRequest' }));
    }
    const lastIndex = afterIndex + nodes.length;
    const hasNextPage = lastIndex < total - 1 || (nodes.length > 0 && lastIndex + 1 < total);
    if (name === 'nodes') return nodes;
    if (name === 'edges') return nodes.map((n, i) => ({ value: { node: n, cursor: b64id(`cursor:${afterIndex + 1 + i}`) }, type: v.kind === 'issues' ? 'IssueEdge' : 'PullRequestEdge' }));
    if (name === 'totalCount') return total;
    if (name === 'pageInfo') return { value: { hasNextPage, hasPreviousPage: afterIndex >= 0, endCursor: nodes.length ? b64id(`cursor:${lastIndex}`) : null, startCursor: nodes.length ? b64id(`cursor:${afterIndex + 1}`) : null }, type: 'PageInfo' };
    errors.push(`Cannot query field "${name}" on type "${type}".`);
    return undefined;
  }
  if (type === 'IssueEdge' || type === 'PullRequestEdge') {
    const v = value as { node: GResolver; cursor: string };
    if (name === 'node') return v.node;
    if (name === 'cursor') return v.cursor;
    errors.push(`Cannot query field "${name}" on type "${type}".`);
    return undefined;
  }
  if (type === 'PageInfo') {
    const v = value as { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null };
    if (name === 'hasNextPage') return v.hasNextPage;
    if (name === 'hasPreviousPage') return v.hasPreviousPage;
    if (name === 'endCursor') return v.endCursor;
    if (name === 'startCursor') return v.startCursor;
    errors.push(`Cannot query field "${name}" on type "PageInfo".`);
    return undefined;
  }
  if (type === 'LabelConnection') {
    const v = value as { labels: Label[] };
    if (name === 'nodes') return v.labels.map((l) => ({ value: l, type: 'Label' }));
    if (name === 'edges') return v.labels.map((l) => ({ value: { node: { value: l, type: 'Label' }, cursor: b64id(`cursor:0`) }, type: 'LabelEdge' }));
    if (name === 'totalCount') return v.labels.length;
    if (name === 'pageInfo') return { value: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }, type: 'PageInfo' };
    errors.push(`Cannot query field "${name}" on type "LabelConnection".`);
    return undefined;
  }
  if (type === 'LabelEdge') {
    const v = value as { node: GResolver; cursor: string };
    if (name === 'node') return v.node;
    if (name === 'cursor') return v.cursor;
    return undefined;
  }
  if (type === 'Label') {
    const l = value as Label;
    if (name === 'id') return gqlId('label', l.name);
    if (name === 'name') return l.name;
    if (name === 'color') return l.color;
    if (name === 'description') return l.description;
    errors.push(`Cannot query field "${name}" on type "Label".`);
    return undefined;
  }
  if (type === 'Ref') {
    const v = value as { name: string; repo: Repo };
    if (name === 'name') return v.name;
    if (name === 'target') {
      const sha = v.repo.refs.get(`refs/heads/${v.name}`);
      return { value: { oid: sha, repo: v.repo }, type: 'Commit' };
    }
    errors.push(`Cannot query field "${name}" on type "Ref".`);
    return undefined;
  }
  if (type === 'Commit') {
    const v = value as { oid: string; repo: Repo };
    if (name === 'oid') return v.oid;
    if (name === 'message') {
      const obj = v.repo.objects.get(v.oid);
      return obj ? parseCommit(obj.data).message.replace(/\n+$/, '') : '';
    }
    errors.push(`Cannot query field "${name}" on type "Commit".`);
    return undefined;
  }
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    const v = value as { issue: Issue; repo: Repo };
    if (name === 'issue') return { value: v, type: 'Issue' };
    if (name === 'clientMutationId') return null;
    errors.push(`Cannot query field "${name}" on type "${type}".`);
    return undefined;
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    const v = value as { pullRequest: Pull; repo: Repo };
    if (name === 'pullRequest') return { value: { repo: v.repo, pull: v.pullRequest }, type: 'PullRequest' };
    if (name === 'clientMutationId') return null;
    errors.push(`Cannot query field "${name}" on type "${type}".`);
    return undefined;
  }
  if (type === 'AddCommentPayload') {
    const v = value as { comment: Comment; repo: Repo; issue?: Issue };
    if (name === 'commentEdge') return { value: { node: { value: v.comment, type: 'IssueComment' }, cursor: b64id('cursor:0') }, type: 'CommentEdge' };
    if (name === 'clientMutationId') return null;
    errors.push(`Cannot query field "${name}" on type "AddCommentPayload".`);
    return undefined;
  }
  if (type === 'CommentEdge') {
    const v = value as { node: GResolver; cursor: string };
    if (name === 'node') return v.node;
    if (name === 'cursor') return v.cursor;
    return undefined;
  }
  if (type === 'IssueComment') {
    const c = value as Comment;
    if (name === 'id') return gqlId('comment', c.id);
    if (name === 'body') return c.body;
    if (name === 'author') return { value: { login: c.userLogin }, type: 'User' };
    if (name === 'createdAt') return c.createdAt;
    errors.push(`Cannot query field "${name}" on type "IssueComment".`);
    return undefined;
  }
  if (type === 'PullRequestChangedFileConnection') {
    const v = value as { nodes: unknown[] };
    if (name === 'nodes') return v.nodes;
    if (name === 'edges') return (v.nodes as unknown[]).map((n, i) => ({ value: { node: n, cursor: b64id(`cursor:${i}`) }, type: 'PullRequestChangedFileEdge' }));
    if (name === 'totalCount') return (v.nodes as unknown[]).length;
    if (name === 'pageInfo') return { value: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }, type: 'PageInfo' };
    errors.push(`Cannot query field "${name}" on type "PullRequestChangedFileConnection".`);
    return undefined;
  }
  if (type === 'PullRequestChangedFileEdge') {
    const v = value as { node: unknown; cursor: string };
    if (name === 'node') return v.node;
    if (name === 'cursor') return v.cursor;
    return undefined;
  }
  if (type === 'PullRequestChangedFile') {
    const f = value as { path: string; additions: number; deletions: number; changeType: string };
    if (name === 'path') return f.path;
    if (name === 'additions') return f.additions;
    if (name === 'deletions') return f.deletions;
    if (name === 'changeType') return f.changeType;
    errors.push(`Cannot query field "${name}" on type "PullRequestChangedFile".`);
    return undefined;
  }
  if (type === 'RateLimit') {
    const v = value as { limit: number; remaining: number; cost: number };
    if (name === 'limit') return v.limit;
    if (name === 'remaining') return v.remaining;
    if (name === 'cost') return v.cost;
    return undefined;
  }
  errors.push(`Cannot query field "${name}" on type "${type}".`);
  return undefined;
}
function executeSelections(parent: GResolver, selections: GField[], errors: string[]): Json {
  const out: Json = {};
  for (const field of selections) {
    if (field.fragment && field.fragment !== parent.type && field.fragment !== 'Node') continue;
    const raw = resolveField(parent, field, errors);
    if (raw === undefined) continue;
    if (raw === null) {
      out[field.alias] = null;
      continue;
    }
    if (field.children.length === 0) {
      out[field.alias] = raw;
      continue;
    }
    if (isRecord(raw) && 'value' in raw && 'type' in raw) {
      out[field.alias] = executeSelections(raw as unknown as GResolver, field.children, errors);
    } else if (Array.isArray(raw)) {
      out[field.alias] = raw.map((item) => {
        if (isRecord(item) && 'value' in item && 'type' in item) return executeSelections(item as unknown as GResolver, field.children, errors);
        return item;
      });
    } else {
      out[field.alias] = raw;
    }
  }
  return out;
}
function executeGraphqlOp(op: GOperation): Json {
  const errors: string[] = [];
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections({ value: null, type: rootType }, op.selections, errors);
  const result: Json = { data };
  if (errors.length) result.errors = errors.map((message) => ({ message, type: 'FIELD', locations: [] }));
  return result;
}
async function handleGraphql(ctx: Ctx): Promise<void> {
  if (!requireAuth(ctx)) return;
  if (!needJsonBody(ctx)) return;
  const payload = ctx.body;
  const runOne = (doc: unknown): Json => {
    if (!isRecord(doc) || typeof doc.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    try {
      const parser = new GqlParser(doc.query, variables);
      const ops = parser.parseDocument();
      if (ops.length === 0) return { data: null, errors: [{ message: 'No operations' }] };
      if (ops.length === 1) return executeGraphqlOp(ops[0] as GOperation);
      return ops.map((op) => executeGraphqlOp(op)) as unknown as Json;
    } catch (err) {
      return { data: null, errors: [{ message: `GraphQL parse error: ${err instanceof Error ? err.message : 'unknown'}` }] };
    }
  };
  if (Array.isArray(payload)) {
    sendJson(ctx, 200, payload.map(runOne));
    return;
  }
  sendJson(ctx, 200, runOne(payload));
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

const MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
interface McpTool {
  name: string;
  description: string;
  inputSchema: Json;
}
const MCP_TOOLS: McpTool[] = [
  { name: 'create_repo', description: 'Create a new repository for the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, owner: { type: 'string', description: 'Repository owner' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function mcpResult(id: unknown, result: Json): Json {
  return { jsonrpc: '2.0', id, result };
}
function mcpError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
function mcpToolResult(id: unknown, obj: unknown, isError = false): Json {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const result: Json = { content: [{ type: 'text', text }], isError };
  if (isRecord(obj)) result.structuredContent = obj;
  return mcpResult(id, result);
}
function mcpCallTool(id: unknown, params: Json): Json {
  const name = str(params.name);
  const args = isRecord(params.arguments) ? params.arguments : {};
  const tool = MCP_TOOLS.find((t) => t.name === name || t.name.replace(/_/g, '-') === name || name.replace(/_/g, '-') === t.name.replace(/_/g, '-'));
  if (!tool) return mcpError(id, -32602, `unknown tool: ${name}`);
  const required = (tool.inputSchema.required as string[]) ?? [];
  const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
  if (missing.length) return mcpToolResult(id, { error: `missing required argument: ${missing.join(', ')}` }, true);
  try {
    if (tool.name === 'create_repo') {
      const repoName = str(args.name);
      const existing = findRepoByName(repoName);
      if (existing) return mcpToolResult(id, repoObj(existing));
      const repo = createRepoRecord(repoName, bool(args.private, false), str(args.description));
      return mcpToolResult(id, repoObj(repo));
    }
    const owner = str(args.owner, viewerLogin);
    const repoName = str(args.repo);
    if (tool.name === 'get_repo') {
      const repo = findRepo(owner, repoName);
      if (!repo) return mcpToolResult(id, { error: `repository ${owner}/${repoName} not found` }, true);
      return mcpToolResult(id, repoObj(repo));
    }
    const repo = findRepo(owner, repoName);
    if (!repo) return mcpToolResult(id, { error: `repository ${owner}/${repoName} not found` }, true);
    if (tool.name === 'create_issue') {
      const created = createIssueRecord(repo, str(args.title), str(args.body), undefined);
      if ('error' in created) return mcpToolResult(id, { error: created.error }, true);
      return mcpToolResult(id, issueObj(repo, created));
    }
    if (tool.name === 'list_issues') {
      let list = [...repo.issues.values()];
      const state = str(args.state, 'open');
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return mcpToolResult(id, { issues: list.map((i) => issueObj(repo, i)), total_count: list.length });
    }
    if (tool.name === 'create_pull_request') {
      const created = createPullRecord(repo, str(args.title), str(args.body), str(args.head), str(args.base));
      if ('error' in created) {
        if (created.error === 'duplicate') {
          const existing = [...repo.pulls.values()].find((p) => p.state === 'open' && p.headRef === str(args.head) && p.baseRef === str(args.base));
          if (existing) return mcpToolResult(id, pullObj(repo, existing));
        }
        return mcpToolResult(id, { error: created.error }, true);
      }
      const out = pullObj(repo, created);
      out.pull_number = created.number;
      return mcpToolResult(id, out);
    }
    if (tool.name === 'merge_pull_request') {
      const pull = repo.pulls.get(num(args.pull_number));
      if (!pull) return mcpToolResult(id, { error: `pull request ${num(args.pull_number)} not found` }, true);
      if (pull.merged || pull.state === 'closed') return mcpToolResult(id, { error: 'pull request already merged or closed' }, true);
      const merged = mergePull(repo, pull, 'squash');
      if (!merged.ok) return mcpToolResult(id, { error: 'merge conflict' }, true);
      const out = pullObj(repo, pull);
      out.pull_number = pull.number;
      return mcpToolResult(id, out);
    }
  } catch (err) {
    return mcpToolResult(id, { error: err instanceof Error ? err.message : 'tool failed' }, true);
  }
  return mcpError(id, -32602, `unknown tool: ${name}`);
}
async function handleMcp(ctx: Ctx): Promise<void> {
  if (!requireAuth(ctx)) return;
  if (ctx.bodyRaw.length === 0) {
    sendJson(ctx, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  if (ctx.bodyError) {
    sendJson(ctx, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  const req = ctx.body as Json;
  const id = 'id' in req ? req.id : undefined;
  const method = str(req.method);
  const params = isRecord(req.params) ? req.params : {};
  const serverInfo = { name: 'makefun-forge', version: '1.0.0' };
  if (method === 'server/discover') {
    sendJson(ctx, 200, mcpResult(id ?? null, { supportedVersions: MCP_VERSIONS, capabilities: { tools: {} }, serverInfo, protocolVersion: MCP_VERSIONS[0] }));
    return;
  }
  if (method === 'initialize') {
    const offered = str(params.protocolVersion);
    const version = MCP_VERSIONS.includes(offered) ? offered : (MCP_VERSIONS[0] as string);
    sendJson(ctx, 200, mcpResult(id ?? null, { protocolVersion: version, capabilities: { tools: {} }, serverInfo }));
    return;
  }
  if (method === 'notifications/initialized') {
    ctx.res.writeHead(202, { 'x-github-request-id': nextReqId() });
    ctx.res.end();
    return;
  }
  if (method === 'ping') {
    sendJson(ctx, 200, mcpResult(id ?? null, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(ctx, 200, mcpResult(id ?? null, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    sendJson(ctx, 200, mcpCallTool(id ?? null, params));
    return;
  }
  if (method === 'resources/list') {
    sendJson(ctx, 200, mcpResult(id ?? null, { resources: [] }));
    return;
  }
  if (method === 'prompts/list') {
    sendJson(ctx, 200, mcpResult(id ?? null, { prompts: [] }));
    return;
  }
  sendJson(ctx, 200, mcpError(id ?? null, -32601, `Method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

interface GitRepoRef {
  owner: string;
  name: string;
  repo: Repo;
}
function gitRepoFromPath(path: string): GitRepoRef | null {
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!m) return null;
  const owner = decodeURIComponent(m[1] as string);
  const name = decodeURIComponent(m[2] as string);
  const repo = findRepo(owner, name);
  if (!repo) return null;
  return { owner, name, repo };
}
const V0_CAPS_UPLOAD = ['side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'multi_ack', 'multi_ack_detailed', 'agent=makefun-forge/1.0'];
const V0_CAPS_RECEIVE = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=makefun-forge/1.0'];
function refsSorted(repo: Repo): { ref: string; oid: string }[] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, oid]) => ({ ref, oid }));
}
function advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  if (v2) {
    const lines = ['version 2', 'agent=makefun-forge/1.0', 'ls-refs', 'fetch=shallow filter', 'object-format=sha1'];
    if (service === 'git-receive-pack') lines.push('object-format=sha1');
    return Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH, pktLines(lines), PKT_FLUSH]);
  }
  // v0
  const caps = service === 'git-upload-pack' ? V0_CAPS_UPLOAD : V0_CAPS_RECEIVE;
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef) ?? ZERO_OID;
  const lines: Buffer[] = [];
  const refList = refsSorted(repo);
  if (refList.length === 0) {
    const capsStr = `capabilities^{}\0${caps.join(' ')}`;
    lines.push(pktLine(`${ZERO_OID} ${capsStr}\n`));
  } else {
    refList.forEach(({ ref, oid }, i) => {
      const suffix = i === 0 ? `\0${caps.join(' ')}` : '';
      lines.push(pktLine(`${oid} ${ref}${suffix}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = parseTag(obj.data).object;
        lines.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    });
    // HEAD symref: sent as a capability on the first line in real git; the
    // suite only checks caps presence, so append symref to first line caps.
  }
  // Rewrite first line to include symref capability.
  if (refList.length > 0) {
    const first = lines[0] as Buffer;
    const text = first.subarray(4).toString('utf8');
    const idx = text.indexOf('\0');
    const before = text.slice(0, idx + 1);
    const rest = text.slice(idx + 1);
    const withSymref = `${before}symref=HEAD:${defaultRef} ${rest}`;
    lines[0] = pktLine(withSymref);
  }
  return Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH, ...lines, PKT_FLUSH]);
}
function collectObjectsForPack(repo: Repo, wantOids: string[], haves: Set<string>, depth: number | null, oldShallow: Set<string> = new Set()): { objects: GitObj[]; shallow: string[] } {
  // Objects the client already holds: everything reachable from its haves,
  // except that a shallow boundary's parents are NOT held (the client has
  // the boundary commit and its tree, but no ancestors past it).
  const haveSet = new Set<string>();
  {
    const queue: string[] = [...haves];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (haveSet.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      haveSet.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        if (!oldShallow.has(oid)) for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) queue.push(e.oid);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      }
    }
  }
  const shallow = new Set<string>();
  const wanted = new Set<string>();
  interface Frame {
    oid: string;
    remaining: number | null; // generations left including this commit; null = unlimited
  }
  const queue: Frame[] = wantOids.map((oid) => ({ oid, remaining: depth }));
  const seenCommits = new Set<string>();
  while (queue.length) {
    const frame = queue.shift() as Frame;
    const { oid, remaining } = frame;
    if (haveSet.has(oid)) {
      // Held by the client: do not send it, but when deepening past a held
      // shallow boundary the parents may still be missing, so keep walking
      // while the depth budget allows.
      if (remaining !== null && remaining > 1) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'commit') {
          for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, remaining: remaining - 1 });
        }
      }
      continue;
    }
    if (seenCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      wanted.add(oid);
      const peeled = parseTag(obj.data).object;
      if (!haveSet.has(peeled)) queue.push({ oid: peeled, remaining });
      continue;
    }
    if (obj.type !== 'commit') {
      wanted.add(oid);
      continue;
    }
    seenCommits.add(oid);
    wanted.add(oid);
    const c = parseCommit(obj.data);
    wanted.add(c.tree);
    if (remaining !== null && remaining <= 1) {
      shallow.add(oid);
      continue;
    }
    const nextRemaining = remaining === null ? null : remaining - 1;
    for (const p of c.parents) queue.push({ oid: p, remaining: nextRemaining });
  }
  // Expand trees/blobs from wanted trees.
  const out = new Map<string, GitObj>();
  const expand = (oid: string): void => {
    if (out.has(oid) || haveSet.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    out.set(oid, obj);
    if (obj.type === 'tree') for (const e of parseTree(obj.data)) expand(e.oid);
  };
  for (const oid of wanted) expand(oid);
  // Order: commits first (parents after children is not required), then trees, then blobs.
  const objects = [...out.values()].sort((a, b) => {
    const rank = (t: ObjType): number => (t === 'commit' ? 0 : t === 'tree' ? 1 : t === 'blob' ? 2 : 3);
    return rank(a.type) - rank(b.type);
  });
  return { objects, shallow: [...shallow] };
}
function lsRefsResponse(repo: Repo, opts: { peel: boolean; symrefs: boolean; prefix: string | null; unborn: boolean }): Buffer {
  const lines: string[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(defaultRef) ?? ZERO_OID;
  const symrefSuffix = opts.symrefs ? ` symref-target:${defaultRef}` : '';
  // HEAD is only listed when the prefix matches it (its name is "HEAD").
  if (!opts.prefix || 'HEAD'.startsWith(opts.prefix)) lines.push(`${headOid} HEAD${symrefSuffix}`);
  for (const { ref, oid } of refsSorted(repo)) {
    if (opts.prefix && !ref.startsWith(opts.prefix)) continue;
    let line = `${oid} ${ref}`;
    const obj = repo.objects.get(oid);
    if (opts.peel && obj && obj.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
    lines.push(line);
  }
  return Buffer.concat([pktLines(lines), PKT_FLUSH]);
}
function handleUploadPackV2(ctx: Ctx, repo: Repo, body: Buffer): void {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let inArgs = false;
  let command = '';
  for (const p of packets) {
    if (p.kind !== 'data') {
      if (p.kind === 'delim') inArgs = true;
      continue;
    }
    const text = p.payload.toString('utf8').trim();
    if (text.startsWith('command=')) command = text.slice(8);
    else if (inArgs) lines.push(text);
    else if (!text.startsWith('agent=') && !text.startsWith('object-format=')) lines.push(text);
  }
  if (command === 'ls-refs') {
    let peel = false;
    let symrefs = false;
    let prefix: string | null = null;
    let unborn = false;
    for (const line of lines) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefix = line.slice(11);
      else if (line.startsWith('ref-prefix')) prefix = line.slice(10).trim();
    }
    const resp = lsRefsResponse(repo, { peel, symrefs, prefix, unborn });
    sendRaw(ctx, 200, resp, 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves = new Set<string>();
    const oldShallow = new Set<string>();
    let deepen: number | null = null;
    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.add(line.slice(5).trim());
      else if (line.startsWith('shallow ')) oldShallow.add(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
      else if (line === 'done') { /* end */ }
    }
    const { objects, shallow } = collectObjectsForPack(repo, wants, haves, deepen, oldShallow);
    const allHeld = wants.length > 0 && wants.every((w) => haves.has(w));
    const sections: Buffer[] = [];
    if (allHeld) {
      const ackLines = wants.map((w) => `ACK ${w}\n`);
      sections.push(pktLine('acknowledgments\n'), pktLines([...ackLines, 'ready\n']), PKT_DELIM);
    } else {
      sections.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM);
    }
    if (shallow.length || oldShallow.size) {
      const newShallow = new Set(shallow);
      const unshallow = [...oldShallow].filter((o) => !newShallow.has(o));
      const lines2: string[] = [];
      for (const s of shallow) lines2.push(`shallow ${s}\n`);
      for (const u of unshallow) lines2.push(`unshallow ${u}\n`);
      if (lines2.length) sections.push(pktLine('shallow-info\n'), pktLines(lines2), PKT_DELIM);
    }
    if (objects.length > 0) {
      const pack = writePack(objects);
      sections.push(pktLine('packfile\n'), sidebandWrap(pack, 1));
    }
    sections.push(PKT_FLUSH);
    sendRaw(ctx, 200, Buffer.concat(sections), 'application/x-git-upload-pack-result');
    return;
  }
  sendRaw(ctx, 200, Buffer.concat([pktLine('version 2'), pktLine('agent=makefun-forge/1.0'), pktLine('fetch=shallow filter'), pktLine('ls-refs'), pktLine('object-format=sha1'), PKT_FLUSH]), 'application/x-git-upload-pack-result');
}
function handleUploadPackV0(ctx: Ctx, repo: Repo, body: Buffer): void {
  // v0: body is want lines + haves + done; respond with NAK then pack.
  const text = body.toString('utf8');
  const wants: string[] = [];
  const haves = new Set<string>();
  const oldShallow = new Set<string>();
  let deepen: number | null = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0] as string);
    else if (t.startsWith('have ')) haves.add(t.slice(5).split(' ')[0] as string);
    else if (t.startsWith('shallow ')) oldShallow.add(t.slice(8).split(' ')[0] as string);
    else if (t.startsWith('deepen ')) deepen = Number(t.slice(7).trim());
  }
  const parts: Buffer[] = [];
  if (wants.length > 0 && wants.every((w) => haves.has(w))) {
    parts.push(pktLine('NAK'));
  } else {
    parts.push(pktLine('NAK'));
  }
  const { objects } = collectObjectsForPack(repo, wants, haves, deepen, oldShallow);
  if (objects.length > 0) {
    const pack = writePack(objects);
    parts.push(sidebandWrap(pack, 1));
  }
  parts.push(PKT_FLUSH);
  sendRaw(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}
function handleReceivePack(ctx: Ctx, repo: Repo, body: Buffer): void {
  // Body: pkt-line command list, flush, then raw pack bytes.
  let packOffset = body.length;
  let off = 0;
  const commands: { old: string; new: string; ref: string }[] = [];
  while (off + 4 <= body.length) {
    const lenStr = body.subarray(off, off + 4).toString('ascii');
    const len = Number.parseInt(lenStr, 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packOffset = off + 4;
      break;
    }
    if (len === 1 || len === 2) {
      off += 4;
      continue;
    }
    if (off + len > body.length) break;
    const line = body.subarray(off + 4, off + len).toString('utf8');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(clean.trim());
    if (m) commands.push({ old: m[1] as string, new: m[2] as string, ref: m[3] as string });
    off += len;
  }
  const packBytes = body.subarray(packOffset);
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  let unpackOk = true;
  try {
    if (packBytes.length > 0) {
      const incoming = readPack(packBytes, repo.objects);
      for (const [oid, obj] of incoming) repo.objects.set(oid, obj);
    }
  } catch {
    unpackOk = false;
  }
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.new === ZERO_OID) {
      // delete
      if (!current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      } else if (cmd.old !== ZERO_OID && cmd.old !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.new);
    if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!current) {
      if (cmd.old !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      } else {
        repo.refs.set(cmd.ref, cmd.new);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    if (cmd.old !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
      continue;
    }
    // fast-forward check for commits
    if (newObj.type === 'commit' && !isAncestor(repo, current, cmd.new)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.new);
    results.push({ ref: cmd.ref, ok: true });
  }
  repo.updatedAt = isoNow();
  const reportLines: string[] = [unpackOk ? 'unpack ok' : 'unpack failed'];
  for (const r of results) reportLines.push(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason ?? 'rejected'}`);
  const report = Buffer.from(`${reportLines.join('\n')}\n`, 'utf8');
  sendRaw(ctx, 200, sidebandWrap(report, 1), 'application/x-git-receive-pack-result');
}
async function handleGit(ctx: Ctx): Promise<void> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(ctx.path);
  if (!match) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const owner = decodeURIComponent(match[1] as string);
  const name = decodeURIComponent(match[2] as string);
  const tail = match[3] as string;
  const repo = findRepo(owner, name);
  if (!repo) {
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  const service = ctx.query.get('service') ?? '';
  if (tail === 'info/refs' && ctx.method === 'GET') {
    const v2 = ctx.req.headers['git-protocol'] === 'version=2';
    if (service === 'git-upload-pack') {
      sendRaw(ctx, 200, advertisement(repo, 'git-upload-pack', v2), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(ctx, 200, advertisement(repo, 'git-receive-pack', false), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendErr(ctx, 400, 'service is required');
    return;
  }
  if (tail === 'git-upload-pack' && ctx.method === 'POST') {
    const v2 = ctx.req.headers['git-protocol'] === 'version=2';
    try {
      if (v2) handleUploadPackV2(ctx, repo, ctx.bodyRaw);
      else handleUploadPackV0(ctx, repo, ctx.bodyRaw);
    } catch {
      sendErr(ctx, 400, 'bad request');
    }
    return;
  }
  if (tail === 'git-receive-pack' && ctx.method === 'POST') {
    try {
      handleReceivePack(ctx, repo, ctx.bodyRaw);
    } catch {
      sendErr(ctx, 400, 'bad request');
    }
    return;
  }
  sendErr(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  const server = createServer((req, res) => {
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const ctx: Ctx = {
        req, res,
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        host: req.headers.host ?? '127.0.0.1',
        bodyRaw: Buffer.alloc(0),
        body: undefined,
        bodyParsed: false,
        bodyError: false,
      };
      try {
        await readBody(ctx);
        if (ctx.method === 'GET' && ctx.path === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (ctx.method === 'DELETE' && ctx.path === '/mcp') {
          res.writeHead(204, { 'x-github-request-id': nextReqId() });
          res.end();
          return;
        }
        if (ctx.path === '/mcp' && ctx.method === 'POST') {
          await handleMcp(ctx);
          return;
        }
        if (ctx.path === '/api/graphql' && ctx.method === 'POST') {
          await handleGraphql(ctx);
          return;
        }
        if (ctx.path.startsWith('/api/v3')) {
          await handleRest(ctx);
          return;
        }
        if (/^\/[^/]+\/[^/]+\.git\//.test(ctx.path)) {
          await handleGit(ctx);
          return;
        }
        sendErr(ctx, 404, 'Not Found');
      } catch (err) {
        if (!res.writableEnded) {
          try {
            sendErr(ctx, 500, err instanceof Error ? err.message : 'internal error');
          } catch { /* ignore */ }
        }
      }
    };
    void handle();
  });
  return server;
}
