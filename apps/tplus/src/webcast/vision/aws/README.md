# TPlus vision — AWS batch stub (OpenCV contest)

**Goal:** show a meaningful AWS path: frames live in **S3**, OpenCV **5** scoring runs on **EC2 Graviton (arm64)**, scores land back in S3 for local `eval_picks` / demos.

Local iteration uses the same `batch_score.py` — only the host changes.

## Layout on S3

```
s3://$TPLUS_VISION_BUCKET/tplus-vision/
  runs/<runId>/vision/frames/*.jpg
  runs/<runId>/vision/picks.jsonl          # optional gold
  runs/<runId>/vision/scores.jsonl         # batch output
  runs/<runId>/vision/scores.summary.json
```

## Staying cheap / Free Tier–friendly (2026)

New AWS accounts (post–July 2025) usually get **~$100–200 credits for ~6 months** rather than the old “750 h of t3.micro forever.” Credits cover small S3 + a short Graviton run easily.

**Also useful:** EC2 **t4g.small** Graviton2 free trial — up to **750 h/month through Dec 31, 2026** ([Graviton getting started](https://aws.amazon.com/ec2/graviton/getting-started/)). Prefer that size for the contest demo.

**Hygiene so you don’t burn credits:**
- Region: `us-west-2` or `us-east-1` (pick one; stick to it)
- Create a **Budget alert** at $5–10 (onboarding credit task + peace of mind)
- **Stop/terminate** the instance when scoring is done (don’t leave it up)
- Keep S3 to our vision packs only (~hundreds of MB), delete when contest ends if you want
- Skip NAT gateways, load balancers, RDS, public AMIs with huge disks

## One-time setup

1. Create a bucket (example `us-west-2`):

```bash
export TPLUS_VISION_BUCKET=tplus-vision-<your-uniq>
export AWS_REGION=us-west-2
aws s3 mb "s3://$TPLUS_VISION_BUCKET" --region "$AWS_REGION"
```

2. IAM: user/role that can `s3:PutObject/GetObject/ListBucket` on that prefix, plus ability to run EC2 (or use an existing bastion).

3. Launch a small **Graviton** instance (contest-friendly):

| | |
|--|--|
| AMI | Amazon Linux 2023 **arm64** |
| Type | **`t4g.small`** (free-trial eligible through end of 2026) |
| Storage | **8–20 GB** gp3 is enough for a couple of flights |
| Access | SSH key; security group: SSH from your IP only |

4. On the instance:

```bash
sudo dnf install -y python3.11 python3.11-pip git
python3.11 -m venv ~/venv-vision
source ~/venv-vision/bin/activate
pip install -U pip
pip install 'opencv-python-headless>=5,<6' numpy
# copy or git-clone the vision/ folder (score_frame.py + batch_score.py)
```

## Sync + score + pull

From a machine with AWS CLI + the run archives (desktop):

```bash
export TPLUS_VISION_BUCKET=tplus-vision-<your-uniq>
export RUN=2026-09-20T01-17-04-falcon-9-block-5-starlink-group-15-27
export RUN_DIR=~/cue/tplus-webcast/runs/$RUN

# 1) upload frames (+ picks if present)
./apps/tplus/src/webcast/vision/aws/sync_to_s3.sh "$RUN_DIR"

# 2) on the Graviton instance — after syncing the same prefix down:
./apps/tplus/src/webcast/vision/aws/run_batch_on_host.sh "$RUN_DIR"

# 3) upload scores (from instance) or pull them locally:
aws s3 sync "s3://$TPLUS_VISION_BUCKET/tplus-vision/runs/$RUN/vision/" \
  "$RUN_DIR/vision/" --exclude '*' --include 'scores*'
```

`run_batch_on_host.sh` is just a thin wrapper around:

```bash
python batch_score.py --run-dir "$RUN_DIR"
```

## Contest talking points

- **OpenCV 5** (`cv2.__version__` recorded in `scores.summary.json`)
- **AWS**: S3 object store + EC2 Graviton batch host (arm64 in summary `machine`)
- **Same scorer** locally and in cloud — no cloud-only black box
- Gold `picks.jsonl` eval: `python eval_picks.py --run-dir …` after scores exist (eval still uses live `_score`; optional future: rank from scores.jsonl)

## COOL / special awards (optional later)

If chasing Best Use of COOL: wrap `batch_score.py` in a container and run via AWS Batch / Fargate on Graviton. The stub above is enough for the required “meaningful AWS component.”
