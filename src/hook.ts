#!/usr/bin/env bun
// Ponto de entrada do hook da Hades: o ~/.claude/settings.json chama `bun …/src/hook.ts` direto, sem o roteador da CLI
// nem Python no meio (a latência do hook importa: roda em toda chamada de ferramenta). Lógica em src/lib/guard-hook.ts.
import { runHook } from "./lib/guard-hook-main.ts";

process.exitCode = await runHook(process.argv.slice(2));
