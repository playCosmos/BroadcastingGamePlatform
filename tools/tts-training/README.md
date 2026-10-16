# GameCenter | Qwen3-TTS 로컬 학습 환경

> **범위:** 캐릭터 음성 데이터 준비와 Qwen3-TTS 단일 화자 파인튜닝 실험용. GameCenter 서버, TTS 릴리스, 게임 연계에는 영향 없음.

## 대상과 상태

- Windows 11 + RTX 4090(24GB) + **WSL2 Ubuntu 24.04** 또는 네이티브 Ubuntu.
- Python 3.12(또는 3.11), PyTorch 2.8.0 CUDA 12.8, 공식 Qwen3-TTS 소스 SHA `022e286b98fbec7e1e916cb940cdf532cd9f488e`에 고정.
- 학습 모델 후보: Qwen3-TTS-12Hz-0.6B-Base(실험적 차원 수정 적용), 1.7B-Base(공식 코드지만 전체 AdamW 학습은 24GB에서 OOM 가능). **RTX 4090 실기동 학습은 아직 검증 전**.
- WSL2에는 NVIDIA Windows GPU 드라이버가 노출되어야 함. WSL2에 Linux 디스플레이 드라이버를 따로 설치하지 말 것.
- 학습에 FlashAttention 2가 필요하며 `nvcc`가 없으면 준비만 가능. CUDA Toolkit은 별도로 설치해야 함.
- 기존 RVC `.pth`는 Qwen3-TTS 모델로 변환되지 않음. `data/raw/`에는 **허가된 원본 녹음과 정확한 대본**을 사용.

## 1. Windows 측 최초 설치

관리자 PowerShell에서 WSL이 없는 경우:

```powershell
wsl --install -d Ubuntu-24.04
wsl --update
```

재부팅이 요청되면 재부팅하고 Ubuntu를 초기화한다. **Windows NVIDIA 드라이버를 WSL CUDA 지원 버전으로 설치**하고 `wsl -d Ubuntu-24.04` 안에서 `nvidia-smi`가 GPU를 찾는지 확인한다.

Ubuntu 터미널:

```bash
sudo apt update
sudo apt install -y git ffmpeg python3 python3-venv python3-dev build-essential ninja-build libsndfile1
nvidia-smi
```

저장소를 WSL의 `~/` 아래에 가져오는 것이 좋다. Windows `/mnt/c`의 파일을 직접 학습 폴더로 쓰면 I/O가 느려질 수 있다.

```bash
git clone -b feature/tts-training-environment https://github.com/playCosmos/BroadcastingGamePlatform.git ~/GameCenter
cd ~/GameCenter/tools/tts-training
bash setup.sh
.venv/bin/python doctor.py --require-ready
```

`setup.sh`는 Python 가상환경만 수정하고, CUDA용 PyTorch와 공식 upstream 소스(고정 SHA)를 설치한다. **모델 파일은 자동 다운로드하지 않고 학습도 시작하지 않는다.** FlashAttention 빌드용 CUDA Toolkit(`nvcc`)은 별도 준비가 필요하다. `nvcc`가 없으면 경고를 남기고 설치 준비까지만 끝난다. 실제 WSL2 GPU 드라이버·VRAM 확인은 `doctor.py`로 한다.

## 2. 개인 원본 음성 및 대본

`tools/tts-training/data/raw/` 안에 WAV/FLAC/MP3/M4A/OGG 원본을 놓고 `transcripts.csv`(UTF-8)를 작성한다.

```csv
file,text
clip0001.wav,안녕하세요. 방송에 오신 것을 환영합니다.
clip0002.wav,오늘은 어떤 게임을 시작할까요?
```

파일 하나는 **하나의 정확한 문장**과 짝지어야 한다. 원본 녹음을 임의로 분할하거나 텍스트를 추정하지 않는다. 음성과 대본이 일치하도록 1~20초 발화 단위로 편집한다. 배경 음악, 다른 사람 목소리, 심한 노이즈는 제거하고 원래 캐릭터 음색을 유지한다. 사용 권한이 확인된 음성만 사용한다.

```bash
cd ~/GameCenter/tools/tts-training
.venv/bin/python prepare_dataset.py --dry-run
.venv/bin/python prepare_dataset.py
```

출력: `data/prepared/wav/*.wav`(24kHz/mono/16-bit PCM), `train_raw.jsonl`, `validation_raw.jsonl`, `summary.json`.
훈련/검증 분리는 시드 42, 기본 검증 비율 10%로 재현 가능하며 **서로 다른 발화 파일을 사용**한다. 하나의 학습 파일을 모든 행의 `ref_audio`로 사용한다. 변경 시 `data/prepared`를 새 이름으로 보관하고 새 폴더에 다시 생성하라. 스크립트는 데이터를 덮어쓰지 않는다.

## 3. 모델 다운로드 (별도 명시적 실행)

```bash
.venv/bin/python fetch_models.py --size 0.6B
```

공식 Hugging Face의 모델과 토크나이저를 내려받고 정확한 Hub 리비전을 각 모델 폴더에 기록한다. 내려받는 체크포인트는 수 GB에 달할 수 있다. 기계 학습 모델은 신뢰한 저장소에서만 받는다. 네트워크 제한이나 약관 및 재배포 조건을 별도 확인한다.

## 4. 첫 실험 (데이터 준비 및 CUDA 점검 후에만)

```bash
.venv/bin/python doctor.py --require-ready
bash train.sh 0.6B
```

`train.sh`는 입력 오디오 토큰화(`train_with_codes.jsonl`)와 2 epoch의 학습을 시작한다. 배치 1, 학습률 2e-6, 고정 화자 `character_1`이 초기 설정이다. 출력은 시간별 `runs/qwen-0.6B-*/checkpoints/checkpoint-epoch-*`에 기록한다.

**중요:** 공식 0.6B 파인튜닝에서 text embedding 차원 불일치가 보고되었다. 이 구성은 고정된 upstream 스크립트를 직접 수정하지 않고 `patch_sft.py`로 **실험용 복사본**에 text projection을 적용한다. 해당 수정만으로 수렴·음질이 보장되지 않는다. 학습 중 OOM이나 잡음이 나면 스크립트를 무턱대고 재시작하지 말고 로그와 생성 음성을 확인한다. 1.7B 옵션은 `fetch_models.py --size 1.7B` 및 `train.sh 1.7B`이지만 RTX 4090 24GB에서 전체 파인튜닝은 VRAM이 부족할 수 있다.

## 5. 결과 청취 및 품질 판단

```bash
.venv/bin/python infer_checkpoint.py --checkpoint runs/qwen-0.6B-YYYYMMDDTHHMMSSZ/checkpoints/checkpoint-epoch-0 --text '오늘은 새로운 캐릭터 목소리를 테스트합니다.' --output outputs/epoch0.wav
```

학습하지 않은 문장, 숫자·외래어·문장 길이별 테스트를 사용하고 초기 체크포인트부터 비교한다. 추론 코드에 신뢰할 수 없는 체크포인트 디렉터리를 전달하지 않는다.

## 격리·보안·제약

- 원본 음성, 대본, 모델, 학습 로그, 캐시, 생성 WAV, RVC `.pth`와 `.index`는 `tools/tts-training/.gitignore`로 제외.
- `git add -f` 등으로 강제 추가하거나 공개 Issue/CI 로그에 원본 음성·개인 녹음을 첨부하지 않는다.
- Linux 환경 설치와 모델 다운로드는 **실제 학습 PC에서 실행**해야 한다. GitHub Actions는 GPU 없는 스크립트 구조·데이터 처리 테스트만 수행.
- 기존 Java TTS와는 독립. 직접 TTS, RVC 음색 변환, 게임·OBS 이벤트 연계는 이 단계에서 구현하지 않는다.
- 실행 환경 메타데이터는 `logs/pip-freeze.txt`, `logs/upstream-commit.txt`, 모델별 `.gamecenter-revision.json`으로 로컬 기록.

참고: [Qwen3-TTS 공식 학습 방법](https://github.com/QwenLM/Qwen3-TTS/blob/main/finetuning/README.md) · [공식 upstream 0.6B 차원 문제](https://github.com/QwenLM/Qwen3-TTS/issues/120) · [PyTorch CUDA 설치](https://pytorch.org/get-started/previous-versions/).
