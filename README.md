# pi-promptimize

`/promptimize` for the [pi coding agent](https://github.com/earendil-works/pi) and [oh-my-pi](https://github.com/can1357/oh-my-pi): a popup where you type a rough prompt, pick a size and get an optimized prompt back, after a short interview when the prompt leaves real gaps.

## Install

**pi**

```bash
pi install git:github.com/dimitritholen/pi-promptimize
```

The repo is private: git on that machine needs access to it (`gh auth login` + `gh auth setup-git`, or an SSH key).

**oh-my-pi (omp)**

```bash
omp plugin install git:github.com/KD-MM2/pi-promptimize
```

omp loads the same extension through its pi-compat layer; the few APIs the two hosts differ on
(settings, model listing, thinking level, key resolution, theme symbols) are detected and
adapted at runtime in `extensions/promptimize/host.ts`.

## Use

Open the popup with `/promptimize [text]` or `alt+p` (`alt+p` only when your terminal sends Option as Alt).

1. **Compose.** The top row shows the model that writes the prompt: Shift+Tab to it, ←/→ switches, Enter opens a list you can filter by typing (same models as `/model`). Type the rough prompt, choose a size and, if the prompt refers to the conversation ("fix that", "the same for X"), tick *Include recent session context*.
   - **Small:** terse, 1 to 6 lines.
   - **Medium:** compact Markdown sections, about 100 to 250 words.
   - **Large:** a complete prompt of about 300 to 700 words with role, approach, constraints, a self-check and an output contract.
2. **Interview.** Only when the prompt leaves gaps that matter and that the target cannot find out itself, the model asks questions first, each with a suggested default. Budget: small 2 questions in 1 round, medium 3 in up to 2 rounds, large 4 in up to 3 rounds. Enter answers; an empty Enter takes the default; `-` skips; Tab takes the defaults for the rest and generates.
3. **Review.** The popup shows the result. Enter puts it in pi's editor; `r` regenerates; ←/→ or 1-3 switches size (keeps your answers); `e` goes back to edit the prompt; ↑/↓ scrolls.

The prompt is written for a coding agent working in the current directory, unless your prompt clearly targets something else. What the agent can look up becomes an instruction to look it up; only what you alone know and the result cannot do without becomes an `[INSERT X]` placeholder.

Keys in the compose step: Tab moves between fields, ←/→ or 1-3 picks the size, Space toggles the context box, Shift+Enter adds a newline, Esc cancels a running request or closes the popup. The popup remembers your last model, size, context choice and unfinished prompt until pi restarts.

## Settings

### pi

In `~/.pi/agent/settings.json` (or a project's `.pi/settings.json`):

```json
"promptimize": {
  "model": "anthropic/claude-opus-5-5",
  "includeContext": false
}
```

### oh-my-pi

```bash
omp plugin config set pi-promptimize model anthropic/claude-opus-5-5
omp plugin config set pi-promptimize includeContext true
```

Stored in `~/.omp/plugins/omp-plugins.lock.json` under `settings.pi-promptimize`. For a per-project override, create `<project>/.omp/plugin-overrides.json`:

```json
{ "settings": { "pi-promptimize": { "model": "anthropic/claude-opus-4-8" } } }
```

`PROMPTIMIZE_MODEL` and `PROMPTIMIZE_INCLUDE_CONTEXT` (`1|true|yes|on`) are honored as fallbacks when nothing is stored.

### Both hosts

- `model`: the model the popup starts with, as `provider/id`. Default: the session's model. A model you pick in the popup wins until the process restarts. Unknown ids fall back to the session model with a warning.
- `includeContext`: the default of the context box. Default `false`; it costs tokens.

It uses the session's thinking level; the interview call is capped at low. If a model rejects the thinking level, the call is retried once without it. On oh-my-pi, model calls go through pi-ai's `streamSimple` with the registry's per-request key resolver, so stored API keys and OAuth credentials both work. On pi, calls go through `modelRegistry.streamSimple` as usual.

## Test

```bash
npm test            # unit tests, no model calls
npm run eval        # real model: 10 rough prompts × 3 sizes, checked automatically
```

The eval answers interview questions with their defaults and checks per output: that it is a prompt and not the task's result (a judge call), language, length per size, number of placeholders, verbatim details, and no questions on an already clear prompt. Options: `--model provider/id`, `--thinking level`, `--sizes small,medium`, `--cases id,id`, `--concurrency n`. Full outputs go to `eval/out/` (git-ignored). A full run makes about 90 model calls.
