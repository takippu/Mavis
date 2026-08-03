# Smoke Guide box renderer.
#   python render.py guide.json          -> plain boxes (default; safe to paste in chat)
#   python render.py guide.json --ansi   -> colored, for the user's own terminal
# guide.json = { "width": 72, "boxes": [ {"title": "...", "groups": [["line", ...], ...]} ] }
import sys, json

def render(data, ansi=False):
    W = data.get("width", 72); TEXT = W - 4
    if ansi:
        G="\033[1;32m"; GRY="\033[90m"; CY="\033[36m"; YL="\033[33m"; RD="\033[1;31m"; BD="\033[1m"; RS="\033[0m"
    else:
        G=GRY=CY=YL=RD=BD=RS=""
    SEC = {"ROUTE": CY, "EXPECTED": YL, "REGRESSION": RD}
    def content(text, state):
        cur = state["c"]; hdr = False
        if text and not text.startswith(" "):
            w = text.split()[0].rstrip(":.") if text.strip() else ""
            if w in SEC: cur = SEC[w]; hdr = True
            else: cur = ""
            state["c"] = cur
        style = (BD if hdr else "") + cur
        return GRY+"| "+RS + style + text[:TEXT].ljust(TEXT) + RS + GRY+" |"+RS
    out = []
    for i, box in enumerate(data["boxes"]):
        if i: out.append("")
        t = box.get("title", ""); pre = "+-[ "; suf = " ]"
        n = W - len(pre) - len(t) - len(suf) - 1
        out.append(GRY+pre+RS + G+t+RS + GRY+suf + "-"*n + "+"+RS)
        state = {"c": ""}; first = True
        for group in box["groups"]:
            if not first: out.append(content("", state))
            first = False
            state["c"] = ""
            for line in group: out.append(content(line, state))
        out.append(GRY+"+"+"-"*(W-2)+"+"+RS)
    return "\n".join(out)

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ansi = "--ansi" in sys.argv
    with open(args[0], encoding="utf-8") as f:
        data = json.load(f)
    sys.stdout.write(render(data, ansi) + "\n")
