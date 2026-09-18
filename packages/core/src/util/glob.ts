/** Minimal glob → RegExp: `**`, `*`, `?`, `{a,b}`; matches forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; `**` alone matches anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i++;
      } else {
        const alts = glob
          .slice(i + 1, end)
          .split(",")
          .map((a) => escapeRe(a));
        re += `(?:${alts.join("|")})`;
        i = end + 1;
      }
    } else {
      re += escapeRe(c);
      i++;
    }
  }
  return new RegExp(re + "$");
}

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
