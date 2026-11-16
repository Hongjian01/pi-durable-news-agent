"""Collect a pending-label pool from explicitly licensed public repository documents.

No provider keys, paid APIs, production databases, or third-party code execution.
Git history supplies actual file-update dates; acquisition time is never publication time.
"""
import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import pathlib
import re
import subprocess
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

REPOSITORIES = [
    ("agentscope-ai/agentscope", "agentscope", "Apache-2.0", "test"),
    ("agentscope-ai/agentscope-java", "agentscope", "Apache-2.0", "test"),
    ("QwenLM/Qwen-Agent", "qwen-agent", "Apache-2.0", "dev"),
    ("pydantic/pydantic-ai", "pydantic-ai", "MIT", "dev"),
    ("langchain-ai/langgraph", "langchain", "MIT", "test"),
    ("numpy/numpy", "numpy", "BSD-3-Clause", "test"),
]
HTTP_CACHE = {}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def get(url):
    if url in HTTP_CACHE:
        return HTTP_CACHE[url]
    request = urllib.request.Request(url, headers={"User-Agent": "AgentRadar-public-source-preparation/1"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                body = response.read(2 * 1024 * 1024 + 1)
                if len(body) > 2 * 1024 * 1024:
                    raise ValueError("source_over_2MiB")
                return body.decode("utf-8")
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True, timeout=120).stdout


def updated_files(history, shallow):
    """A shallow boundary appears as a root diff; its file dates are unknowable."""
    latest = {}
    commit, date = None, None
    for line in history.splitlines():
        if line.startswith("@@"):
            commit, date = line[2:].split(" ", 1)
        elif eligible(line) and line not in latest and commit not in shallow:
            latest[line] = (commit, date)
    return latest


def eligible(path):
    lower = path.lower()
    return (
        lower.endswith((".md", ".mdx", ".rst"))
        and (lower.startswith(("docs/", "doc/")) or lower.startswith(("readme", "changelog")))
        and not any(part in lower for part in ["contributing", "contributors", "license", "notice", "privacy", "security.md"])
    )


def sensitive(text):
    patterns = {
        "email": r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}",
        "private_key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        "provider_token": r"\b(?:ghp_|github_pat_|sk-(?:proj-|or-v1-)?)[A-Za-z0-9_-]{20,}",
        "credential_url": r"https?://[^\s/@:]+:[^\s/@]+@",
        "credential_query": r"[?&](?:token|access_token|api_key|secret|password)=[^\s&#)\]<>]+",
        "assigned_credential": r"(?i)(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[\"'][A-Za-z0-9_-]{24,}[\"']",
    }
    return [name for name, pattern in patterns.items() if re.search(pattern, text, re.I)]


def collect_repository(config, cache, now, days):
    repository, family, spdx, split = config
    directory = cache / repository.replace("/", "--")
    if not directory.exists():
        subprocess.run(["git", "clone", "--bare", "--filter=blob:none", "--depth=250", "--single-branch", "https://github.com/" + repository + ".git", str(directory)], check=True, capture_output=True, timeout=240)
    sha = git(directory, "rev-parse", "HEAD").strip()
    history = git(directory, "log", "--format=@@%H %cI", "--name-only", "--diff-filter=AM", "-250")
    boundary = directory / "shallow"
    shallow = set(boundary.read_text().splitlines()) if boundary.exists() else set()
    latest = updated_files(history, shallow)
    # Only files present at the immutable HEAD; renamed/deleted paths are excluded.
    present = set(git(directory, "ls-tree", "-r", "--name-only", "HEAD").splitlines())
    files = []
    cutoff = now - dt.timedelta(days=days)
    for path, (changed, date) in latest.items():
        updated = dt.datetime.fromisoformat(date)
        if path in present and cutoff <= updated <= now:
            files.append((path, changed, updated.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")))
    # Resolve licenses at the same revision as the document, retain complete notices.
    notices = {}
    for name in ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "NOTICE", "NOTICE.txt"]:
        if name in present:
            notices[name] = get(f"https://raw.githubusercontent.com/{repository}/{sha}/{name}")
    if not notices:
        raise ValueError(f"license_missing:{repository}")
    joined = "\n".join(notices.values())
    expected = {"Apache-2.0": "Apache License", "MIT": "Permission is hereby granted", "BSD-3-Clause": "Redistribution and use"}[spdx]
    if expected not in joined:
        raise ValueError(f"license_not_verified:{repository}:{spdx}")
    # An override beneath docs requires separate review rather than assuming root coverage.
    overrides = [path for path in present if "/" in path and re.search(r"(?:^|/)(?:LICENSE|COPYING)(?:\.[^/]*)?$", path, re.I)]
    info = dict(repository=repository, family=family, spdx=spdx, split=split, revision=sha,
                licenseFiles=notices, nestedLicenseFiles=overrides,
                historyDepth=250, candidatesWithinWindow=len(files))
    documents, excluded = [], []
    def fetch(entry):
        path, changed, date = entry
        for override in overrides:
            if path.startswith(override.rsplit("/", 1)[0] + "/"):
                return None, dict(repository=repository, path=path, reason="nested_license_requires_review")
        url = f"https://raw.githubusercontent.com/{repository}/{sha}/{urllib.parse.quote(path)}"
        try:
            body = unicodedata.normalize("NFC", get(url).replace("\r\n", "\n").replace("\r", "\n"))
            issues = sensitive(body)
            if issues:
                return None, dict(repository=repository, path=path, reason="sensitive_content_excluded", detectors=issues)
            if not 250 <= len(body.encode("utf-8")) <= 1024 * 1024:
                return None, dict(repository=repository, path=path, reason="body_size")
            han = len(re.findall(r"[\u3400-\u9fff]", body))
            letters = len(re.findall(r"[A-Za-z]", re.sub(r"```.*?```", "", body, flags=re.S)))
            language = "zh" if han > 100 and han > letters * .45 else "mixed" if han > 30 else "en"
            heading = re.search(r"^#{1,3}\s+(.+)$", body, re.M)
            title = (heading.group(1).strip() if heading else pathlib.PurePosixPath(path).stem.replace("_", " "))
            title = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", title)
            return dict(repository=repository, family=family, spdx=spdx, split=split,
                        revision=sha, path=path, updatedAt=date, updateCommit=changed,
                        rawUrl=url, url=f"https://github.com/{repository}/blob/{sha}/{urllib.parse.quote(path)}",
                        body=body, language=language, title=title), None
        except Exception as error:
            return None, dict(repository=repository, path=path, reason=type(error).__name__)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for document, exclusion in pool.map(fetch, sorted(files)):
            if document:
                documents.append(document)
            else:
                excluded.append(exclusion)
    print(json.dumps(dict(repository=repository, candidates=len(files), accepted=len(documents), excluded=len(excluded))), flush=True)
    return info, documents, excluded


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--reuse-staging", help="Reuse already captured immutable URLs, never an unpinned branch")
    args = parser.parse_args()
    cache, out = pathlib.Path(args.cache).resolve(), pathlib.Path(args.out).resolve()
    if out.exists():
        raise ValueError("destination_exists")
    cache.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc)
    if args.reuse_staging:
        staging = pathlib.Path(args.reuse_staging)
        for line in (staging / "documents.jsonl").read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if re.fullmatch(r"[a-f0-9]{40}", row["revision"]) and f'/{row["revision"]}/' in row["rawUrl"]:
                HTTP_CACHE[row["rawUrl"]] = row["body"]
        previous = json.loads((staging / "acquisition.json").read_text(encoding="utf-8"))
        for repo in previous["repositories"]:
            for path, body in repo["licenseFiles"].items():
                HTTP_CACHE[f'https://raw.githubusercontent.com/{repo["repository"]}/{repo["revision"]}/{path}'] = body
    infos, documents, excluded = [], [], []
    for config in REPOSITORIES:
        try:
            info, rows, rejected = collect_repository(config, cache, now, args.days)
            infos.append(info)
            documents.extend(rows)
            excluded.extend(rejected)
        except Exception as error:
            print(json.dumps(dict(repository=config[0], error=str(error))), flush=True)
            excluded.append(dict(repository=config[0], reason=str(error)))
    out.mkdir(parents=True)
    captured_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    write = lambda name, value: (out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write("acquisition.json", dict(capturedAt=captured_at, windowDays=args.days, repositories=infos,
                                  excluded=excluded, paidApi=False, humanLabels=0,
                                  meaning="Real immutable technical document updates; not a representative breaking-news benchmark. Automatic screening is not manual privacy/cluster review."))
    (out / "documents.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in documents), encoding="utf-8")
    print(json.dumps(dict(output=str(out), documents=len(documents), paidApi=False)), flush=True)


if __name__ == "__main__":
    main()
