#!/usr/bin/env node
/*
 * Builds database.rules.json (Firebase Realtime Database security rules).
 *
 * The admin list comes from VITE_ADMIN_EMAILS (.env.local, then .env), the same list the app
 * uses, so the console and the database agree on who is an admin. Re-run after changing it:
 *
 *   npm run rules:build            → database.rules.json
 *   npx firebase-tools deploy --only database --project <project-id>
 *
 * Model
 *   · Admins (verified Google email in the list) read and write everything, and are the only ones
 *     who can delete a whole project (the app moves it to /trash instead; restore puts it back).
 *   · A project's members are its owner (projectIndex/{pid}/owner/uid) and its collaborators
 *     (projectIndex/{pid}/collaborators/{uid}). Only members read or edit anything of it.
 *   · Anyone signed in can create a project they own, and can join one with its invite token
 *     (projectInvites/{pid}, given out in share links). Members can leave (remove themselves).
 *   · Read-only projects (isLocked / isMasterTemplate / isArchived, set by admins only): members
 *     can still open, play and view them — playback state, presence, intercom — but not edit.
 *     Official templates (isMasterTemplate) can be read by everyone signed in, so they can fork them.
 *   · The audience isn't signed in: it reads the live pointer and a version's showState, and
 *     writes its presence and its uploads (create only, also into the cross-project audienceMedia
 *     index). Nothing else of a project is public.
 *   · Storage: the Default shared libraries are on R2 and admin-managed; Cloudinary holds audience
 *     uploads only, readable by every signed-in operator through audienceMedia.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] ?? join(root, 'database.rules.json')

function envValue(name) {
  if (process.env[name]) return process.env[name]
  for (const file of ['.env.local', '.env']) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    const line = readFileSync(path, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`))
    if (line) return line.slice(name.length + 1).replace(/^["']|["']$/g, '')
  }
  return ''
}

const admins = envValue('VITE_ADMIN_EMAILS')
  .split(/[,\s]+/)
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)
if (admins.length === 0) console.warn('⚠ VITE_ADMIN_EMAILS is empty: nobody will be able to delete or restore projects.')
for (const e of admins) if (!/^[^@\s'"\\]+@[^@\s'"\\]+$/.test(e)) throw new Error(`Not an email address: ${e}`)

const isAdmin = admins.length
  ? `(auth != null && auth.token.email_verified == true && (${admins.map((e) => `auth.token.email.toLowerCase() == '${e}'`).join(' || ')}))`
  : 'false'

/** Membership of $pid in a given snapshot root (`root` = before the write, a newData path = after). */
const memberIn = (r) => `(auth != null && (${r}.child('projectIndex').child($pid).child('owner/uid').val() == auth.uid || ${r}.child('projectIndex').child($pid).child('collaborators').child(auth.uid).exists()))`
const member = memberIn('root')
/** Member after the write, from a rule `depth` levels below the root (lets one update create a project and its data). */
const newRoot = (depth) => `newData${'.parent()'.repeat(depth)}`
const memberAfter = (depth) => memberIn(newRoot(depth))
const or = (...xs) => `(${xs.join(' || ')})`
const and = (...xs) => `(${xs.join(' && ')})`
const flag = (name) => `root.child('projectIndex').child($pid).child('${name}').val() == true`
/** The project is read-only (locked, an official template or archived) — before this write. */
const locked = or(flag('isLocked'), flag('isMasterTemplate'), flag('isArchived'))
const unlocked = `!${locked}`
/** Official templates: any signed-in user may read them. */
const templateReader = and('auth != null', flag('isMasterTemplate'))
/** Only admins change the read-only flags. */
const flagsUnchanged = and(...['isLocked', 'isMasterTemplate', 'isArchived', 'isPinned'].map((f) => `newData.child('${f}').val() == data.child('${f}').val()`))

const rules = {
  rules: {
    // The audience follows /live; operators of that project set it.
    live: {
      '.read': true,
      '.write': or(isAdmin, `(auth != null && (!newData.exists() || root.child('projectIndex').child(newData.child('projectId').val()).child('owner/uid').val() == auth.uid || root.child('projectIndex').child(newData.child('projectId').val()).child('collaborators').child(auth.uid).exists()))`),
    },

    // Whole-index listing is for admins; everyone else reads the projects they belong to.
    projectIndex: {
      '.read': isAdmin,
      $pid: {
        '.read': or(isAdmin, member, templateReader),
        // Create (as its owner, no read-only flags), edit (members, unless read-only), delete (admins
        // only: the app soft-deletes to /trash).
        '.write': or(
          isAdmin,
          and('!data.exists()', "newData.child('owner/uid').val() == auth.uid", 'auth != null', "!newData.child('isLocked').exists()", "!newData.child('isMasterTemplate').exists()", "!newData.child('isArchived').exists()"),
          and(member, 'newData.exists()', unlocked),
        ),
        // The owner can't be changed or dropped, nor the read-only flags, except by an admin.
        '.validate': or(isAdmin, and(or("!data.child('owner').exists()", "newData.child('owner/uid').val() == data.child('owner/uid').val()"), flagsUnchanged)),
        collaborators: {
          $uid: {
            // Join with the project's invite token (share link), or leave (remove yourself).
            '.write': and('auth != null', 'auth.uid == $uid', or("!newData.exists()", "root.child('projectInvites').child($pid).isString() && newData.child('invite').val() == root.child('projectInvites').child($pid).val()")),
          },
        },
      },
    },

    // Invite tokens for share links: members see / rotate them; set by the creator at creation.
    projectInvites: {
      $pid: {
        '.read': or(isAdmin, member),
        '.write': or(isAdmin, member, and('!data.exists()', memberAfter(2))),
      },
    },

    projects: {
      $pid: {
        '.read': or(isAdmin, member, templateReader),
        // Only admins write at the project root — i.e. only they can remove a whole project.
        '.write': isAdmin,
        versions: {
          $vid: {
            // Members edit a version's contents; removing a whole version is for admins.
            '.write': or(isAdmin, and(memberAfter(4), unlocked, 'newData.exists()')),
            // The audience page (no sign-in) follows playback and announces itself. Members can
            // run playback even in a read-only project.
            showState: { '.read': true, '.write': member },
            triggerHost: { '.write': member },
            presence: {
              $aid: {
                '.write': true,
                '.validate': "newData.val() == null || newData.hasChildren() || newData.isNumber() || newData.isBoolean()",
              },
            },
          },
        },
        // Audience uploads: anyone can add one (the moderation pipeline vets it); members manage them.
        uploads: {
          $uploadId: {
            '.write': or(isAdmin, and(memberAfter(4), unlocked), and('!data.exists()', 'newData.exists()')),
          },
        },
        // DAW studios: members create / edit / delete them — except the only studio of a standalone
        // Studio project (that IS the project; admins remove it via the trash).
        studio: {
          $sid: {
            // Studios bound to a cue are rendered on audience devices (the console lists them in
            // projects/{pid}/audienceStudios); only those are readable without signing in.
            '.read': "root.child('projects').child($pid).child('audienceStudios').child($sid).val() == true",
            '.write': or(isAdmin, and(memberAfter(4), unlocked, or('newData.exists()', `root.child('projectIndex').child($pid).child('kind').val() != 'studio'`))),
          },
        },
        // Everything else of a project (surfaces, triggers, media, intercom, activity, …): members
        // edit freely, but can't wipe a whole section in one go.
        // Live-use sections stay writable for members of a read-only project (talk, who's here).
        $section: {
          '.write': or(isAdmin, and(memberAfter(3), 'newData.exists()', or(unlocked, "$section == 'intercom'", "$section == 'studioPresence'"))),
          $item: {
            '.write': or(isAdmin, and(memberAfter(4), or(unlocked, "$section == 'intercom'", "$section == 'studioPresence'"))),
          },
        },
      },
    },

    // Studio owners / collaborators (DAW projects), readable and editable by project members.
    studioMeta: {
      $pid: {
        '.read': or(isAdmin, member, templateReader),
        '.write': or(isAdmin, and(memberAfter(2), 'newData.exists()')),
      },
    },

    // File activity log (global manager → 檔案流動紀錄): anyone signed in appends entries in their
    // own name; entries can't be changed; only admins read (or clear) them.
    fileActivity: {
      '.read': isAdmin,
      '.indexOn': ['at'],
      $id: {
        '.write': or(isAdmin, and('auth != null', '!data.exists()', "newData.child('editor/uid').val() == auth.uid")),
      },
    },

    // Each user's hub entries: only they (and admins) read or change them.
    userProjects: {
      // Admins read everyone's (moving a studio updates the hub entries that point at it).
      '.read': isAdmin,
      $uid: {
        '.read': or(isAdmin, 'auth.uid == $uid'),
        '.write': or(isAdmin, 'auth.uid == $uid'),
      },
    },
    // Each user's own lobby layout (Studio card order, section order, tags): private to them.
    hubLayout: {
      $uid: {
        '.read': 'auth.uid == $uid',
        '.write': 'auth.uid == $uid',
      },
    },
    users: {
      '.read': 'auth != null',
      $uid: { '.write': or(isAdmin, 'auth.uid == $uid') },
    },

    // Shared libraries (cross-project by design): any signed-in operator.
    // The Default shared libraries (files on R2): everyone signed in reads, admins manage.
    sharedMedia: { '.read': 'auth != null', '.write': isAdmin },
    sharedStudioFiles: { '.read': 'auth != null', '.write': isAdmin },

    // Audience uploads (Cloudinary), indexed across projects so every project can use them: any
    // signed-in operator reads; the audience adds entries (create only); members of the project
    // (and admins) update moderation / hidden.
    audienceMedia: {
      '.read': 'auth != null',
      $id: {
        '.write': or(
          isAdmin,
          and('!data.exists()', 'newData.exists()'),
          and('auth != null', 'data.exists()', 'newData.exists()', `(root.child('projectIndex').child(data.child('projectId').val()).child('owner/uid').val() == auth.uid || root.child('projectIndex').child(data.child('projectId').val()).child('collaborators').child(auth.uid).exists())`),
        ),
        '.validate': "newData.hasChildren(['projectId', 'url']) && newData.child('url').isString() && newData.child('url').val().beginsWith('https://res.cloudinary.com/') && (!data.exists() || newData.child('projectId').val() == data.child('projectId').val())",
      },
    },

    // Control-panel modules: anyone signed in loads them; authors (and admins) change / delete theirs.
    surfaceModules: {
      '.read': 'auth != null',
      $id: {
        '.write': and('auth != null', or(isAdmin, and('!data.exists()', "newData.child('by/uid').val() == auth.uid"), "data.child('by/uid').val() == auth.uid")),
      },
    },

    // Soft-deleted projects and archived audience uploads: admins only.
    // File labels and tags from the admin file manager (keyed by an encoded storage key / URL).
    mediaTags: { '.read': 'auth != null', '.write': isAdmin },

    // Official templates list (everyone signed in sees it in the hub); admins maintain it.
    templates: { '.read': 'auth != null', '.write': isAdmin },

    trash: { '.read': isAdmin, '.write': isAdmin },
    trashIndex: { '.read': isAdmin, '.write': isAdmin },
    audienceArchive: { '.read': isAdmin, '.write': isAdmin },

    // Stage 1–3 single-show nodes (legacy): admins only.
    cueList: { '.read': isAdmin, '.write': isAdmin },
    hits: { '.read': isAdmin, '.write': isAdmin },
    showState: { '.read': isAdmin, '.write': isAdmin },
    uploads: { '.read': isAdmin, '.write': isAdmin },
    legacyImportedAt: { '.read': isAdmin, '.write': isAdmin },
  },
}

writeFileSync(out, JSON.stringify(rules, null, 2) + '\n')
console.log(`✓ ${out} — ${admins.length} admin(s)`)
