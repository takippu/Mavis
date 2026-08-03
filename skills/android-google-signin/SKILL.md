# Android Google Sign-In — Skill

Diagnose a native Google Sign-In that fails on Android, in the order that
actually narrows it. Written after a two-hour debugging session where the symptom
was "tap Google, pick an account, stay on the login page, no error anywhere" and
the cause was one line in a console nobody had re-read.

The headline lesson, because it is the one that costs the most time:

> **Play App Signing means the certificate your app presents is NOT the one you
> built with.** A build sideloaded from EAS carries your UPLOAD key; the same
> build installed from Play carries GOOGLE'S app-signing key. They are different
> SHA-1s. "Works sideloaded, fails from Play" is that sentence and almost
> nothing else.

## When to invoke

Load this file when the user says any of:
- "google sign-in doesn't work", "stuck at the login page", "logs in then nothing"
- "ApiException: 10", "DEVELOPER_ERROR", "status code 10", "12500", "12501"
- "works when I sideload but not from Play", "works in dev but not in production"
- "not registered to use OAuth2.0", "SHA-1 fingerprint", "which SHA do I register"
- any Android + Google/OAuth + "it just hangs" report

## The iron rule of this domain

**Never reason about which key is registered. Read the key off the installed
artifact.** Every wrong turn in the origin session came from trusting a stated
belief ("I registered three fingerprints", a console entry literally named
"app signing") over the bytes on the device.

## The ladder

Walk it in order. Each rung eliminates a layer, and skipping one is how the
session took two hours instead of twenty minutes.

### 0. Find out whether the app is silently swallowing the error

Do this FIRST, before any Google-side investigation. If the app discards the
failure, every later rung is being run blind, and the user's "nothing happens"
is a report about the app's error handling rather than about Google.

Read the sign-in call site and ask one question: **can the native picker call
throw somewhere that no handler describes?** The classic shape, and the exact
bug that motivated this skill:

```js
if (canUseNativeGoogle()) {
  const idToken = await getGoogleIdToken();   // OUTSIDE the wrapper that sets authError
  if (idToken === null) return;               // cancellation — correct
  return runAuth('sign-in', () => exchange(idToken));
}
```

The picker was put outside the error wrapper so that a CANCELLATION would not
paint an error. That reasoning is right and the implementation is not:
cancellation returns a sentinel, while every genuine failure THROWS — and those
throws sail past the wrapper into a `catch {}` at the screen that assumes the
wrapper already described them. Result: no message, no log, no crash.

### 1. Split client from server

Is a request even reaching your backend? This is the cheapest, highest-value
split available, and it is one command.

```bash
pm2 logs <app> --err --lines 50 --nostream    # or the equivalent
```

- **No request at the time of the tap** → the failure is on the device, before
  the exchange. Go to rung 2.
- **A request that was rejected** → the token was minted, so the device side
  worked. Go to rung 4.

Note the times of each attempt as you go. In the origin session this split was
what proved the picker was NOT the problem — and then, on a later attempt, that
it was. **Both readings were true at different times**, which is the trap in the
next warning.

### 2. Get the real error out of GMS

The app may hide the error; Google Play Services logs it regardless.

```powershell
adb shell am force-stop <package>
adb logcat -c
# tap the button, pick an account, let it fail
adb logcat -d | Select-String "not registered to use OAuth2.0|ApiException|DEVELOPER_ERROR|GetTokenResponseHandler"
```

The line that ends the argument is Google's own plain-English one:

```
W Auth: [GetTokenResponseHandler] Server returned error: This android application
is not registered to use OAuth2.0, please confirm the package name and SHA-1
certificate fingerprint match what you registered in Google Developer Console.
```

Its absence after a fix is the pass condition. Nothing else is.

**Filter honestly.** `ApiException` and `DEVELOPER_ERROR` are what everyone
greps for and they may never appear — the RN module converts the exception to a
JS rejection, and if the app swallows that (rung 0) it is nowhere. `Auth` and
`GetTokenResponseHandler` are the tags that carry the truth. Also expect
`GoogleSignatureVerifier: package info is not set correctly` beside it; on its
own that line is common and benign, so do not diagnose from it.

### 3. Read the certificate off the INSTALLED app

Not from the keystore, not from Play Console, not from memory.

```bash
adb shell pm path <package>                       # take the base.apk line
adb pull <that path> ./base.apk
apksigner verify --print-certs ./base.apk         # build-tools/*/apksigner
```

Read two things:

- **`Signer #1 certificate SHA-1 digest`** — the fingerprint that must be
  registered. Format it with colons and upper case for the console:
  `sha1.toUpperCase().match(/../g).join(':')`.
- **`Signer #1 certificate DN`** — WHO signed it.
  `CN=Android, OU=Android, O=Google Inc., L=Mountain View` plus a
  "Source Stamp Signer" block means **Play App Signing**, i.e. this is Google's
  key and not yours. Your own upload key shows whatever DN you generated it
  with.

While the APK is open, read the JS bundle too — it settles the "is the app even
configured right" question with no rebuild:

```bash
unzip -p base.apk assets/index.android.bundle \
  | grep -ao "[0-9]\{12\}-[a-z0-9]\{32\}\.apps\.googleusercontent\.com" | sort -u
```

Hermes bytecode keeps string literals in its table, so `grep -a` finds them.
This is also how you verify `EXPO_PUBLIC_*` values actually baked into a
shipped build rather than what `eas.json` claims.

### 3b. Count the keys. There are usually THREE, not two.

Everyone remembers the upload key and Play's app-signing key. **The one that gets
forgotten is the EAS-managed keystore** — created silently on the first EAS build,
stored on Expo's servers, and invisible in every console. It is what signs every
`eas build` artifact, including preview APKs.

So a project built through EAS and shipped through Play typically has:

| key | signs |
|---|---|
| EAS-managed | every `eas build` output — read it with `eas credentials` |
| your own keystore (`credentials.json`) | local Gradle release builds |
| Play App Signing | anything installed FROM Play |

**Each one needs its own Android OAuth client** for a fingerprint-keyed API. Miss
the EAS one and the symptom is inverted from the usual: sideloaded Gradle builds
work, Play installs work, and only the EAS preview build fails.

`eas credentials` is the ONLY place the third one is visible. This is the case
that produced the inverted symptom above: a build signed by a key that exists in
none of the places anyone thinks to look.

**"Package name and fingerprint are already in use"** when registering means the
pair exists SOMEWHERE, and that uniqueness is global across Google. It does not
prove it is in YOUR project. A freshly downloaded `google-services.json` lists
every `client_type: 1` entry with its `certificate_hash`, and that is the read
that settles it.

### 4. Compare against what is actually registered

Open Google Cloud Console → APIs & Services → Credentials for the project whose
number matches the client id's prefix. For each Android client, compare
`package name` + `SHA-1` against rung 3's output, character by character.

**One Android OAuth client per SHA-1.** Play-distributed and sideloaded builds
need two separate clients — do not edit one into the other, or you fix Play and
break your own testing. Neither client is ever named in code: the app names the
WEB client (see rung 5); the Android clients exist only to authorise a
package+certificate pair to ask at all.

`google-services.json` is a fast read of the same state:

```js
const g = require('./google-services.json');
g.client[0].oauth_client   // client_type 1 = Android (has android_info.certificate_hash)
                           // client_type 3 = web
```

An **empty array, or one holding only `client_type: 3`, means no Android client
exists** for that package in that project. That is the failure, visible without
opening a browser. Re-downloading the file after a change is the confirmation
that the change landed.

### 5. If the token IS reaching the server

Then the device half works and the rejection is verification. For Better Auth +
Google the check is in `@better-auth/core/dist/social-providers/google.mjs`:

```js
jwtVerify(token, key, {
  issuer: ["https://accounts.google.com", "accounts.google.com"],
  audience,                    // = your configured clientId
  maxTokenAge: "1h",
})
```

It returns `null` on ANY thrown check and the caller logs one undifferentiated
`Invalid id token`. Five distinct causes wear that one message:

1. **`aud` mismatch** — the client's `webClientId` is not the server's
   `GOOGLE_CLIENT_ID`. Compare both as exact strings INCLUDING LENGTH; a value
   transcribed into a server `.env` can lose characters silently.
2. **A stale cached token.** The native module hands back a cached ID token, and
   Google mints those with a one-hour life. A token from an earlier session
   fails `maxTokenAge` even though the picker "worked".
3. **Clock skew** — jose runs with `clockTolerance: 0`, so an `iat` a few seconds
   in the future is fatal. Check with `date -u` on the origin box, not against a
   CDN's `Date` header, which is the CDN's clock.
4. Signature/`kid`, and 5. issuer — both effectively impossible for a real token.

**The web client id is the right one to configure, on Android, on purpose.** It
decides the token's `aud`, and the server verifies against that same web client.
Naming the Android client yields a valid token the server is correct to reject.

## The trap that cost the most time

Two symptoms coexisted and each pointed somewhere different:

- A rejected token in the SERVER log (`Invalid id token`) — which says the device
  half worked.
- `not registered to use OAuth2.0` in LOGCAT — which says it did not.

Both were real. The device had a **cached ID token from an older sideloaded
build** whose upload key WAS registered; the Play build could no longer mint a
fresh one, and the stale one it replayed had aged past an hour. One root cause,
two contradictory-looking pieces of evidence, and the server-side one is the more
seductive because it arrives with a timestamp and a provider name.

**Rule: a stale artifact from a previously-working configuration can produce
evidence for the wrong layer.** When two rungs disagree, force a clean attempt
(`am force-stop`, clear the log buffer, note the wall-clock time) and re-read
BOTH sources for that one attempt. Do not reason across attempts.

## Pass condition

The `not registered to use OAuth2.0` line absent from a freshly-cleared logcat
buffer after a fresh tap. Console changes take "five minutes to a few hours" by
Google's own warning on the page, so a failure inside five minutes proves
nothing — but only wait once you have verified the registration EXISTS, because
waiting for something that was never created is the other way to lose an hour.

## Leave behind

Whatever the cause, if rung 0 found swallowed errors, fix them. The whole
investigation existed because a clear message from Google was thrown on the
floor instead of being shown to the user. Surfacing it turns the next occurrence
into a screenshot instead of a session.
