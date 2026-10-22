import { useState } from "react";
import { Copy } from "lucide-react";

const INSTALL_ROOT = '"$HOME/.local/share/ccdash-collector/install.py"';
const LEGACY_MAC = '"gui/$(id -u)/com.ccdash.otelcol"';
const COMMANDS = {
  darwin: {
    inspect: `lsof -nP -iTCP:4317 -iTCP:4318 -iTCP:13133 -sTCP:LISTEN
launchctl list | awk '$3 == "com.ccdash.otelcol" || $3 == "org.ccdash.collector"'
/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$HOME/Library/LaunchAgents/com.ccdash.otelcol.plist"`,
    restore: `launchctl enable ${LEGACY_MAC} &&
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.ccdash.otelcol.plist"`,
    logs: 'tail -n 50 "$HOME/.local/share/ccdash-collector/collector.log"',
  },
  linux: {
    inspect: `sudo ss -ltnp '( sport = :4317 or sport = :4318 or sport = :13133 )'
systemctl show otelcol.service --property=FragmentPath,ExecStart
systemctl --user is-active ccdash-collector.service`,
    stop: `sudo test ! -e /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo cp -p /etc/systemd/system/otelcol.service /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo systemctl disable --now otelcol.service &&
sudo rm /etc/systemd/system/otelcol.service &&
sudo systemctl mask otelcol.service`,
    restore: `sudo test -f /etc/systemd/system/otelcol.service.ccdash-backup &&
sudo systemctl unmask otelcol.service &&
sudo mv /etc/systemd/system/otelcol.service.ccdash-backup /etc/systemd/system/otelcol.service &&
sudo systemctl daemon-reload &&
sudo systemctl enable --now otelcol.service`,
    logs: "journalctl --user -u ccdash-collector.service -n 50 --no-pager",
  },
};

function GuideCommand({ label, command }) {
  const [message, setMessage] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setMessage("복사했습니다.");
    } catch {
      setMessage("복사하지 못했습니다. 명령을 직접 선택해 복사해 주세요.");
    }
  }
  return <div className="my-3 overflow-hidden rounded-lg border border-ink-200">
    <div className="flex items-center justify-between gap-3 bg-ink-50 px-3 py-2">
      <span className="text-xs font-medium text-ink-600">{label}</span>
      <button type="button" aria-label={`${label} 복사`} onClick={copy}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-700 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">
        <Copy size={13} aria-hidden="true" />복사</button>
    </div>
    <pre aria-label={label} className="overflow-x-auto bg-ink-900 p-3 text-xs leading-6 text-ink-50"><code>{command}</code></pre>
    {message && <p role="status" className="px-3 py-2 text-xs text-ink-600">{message}</p>}
  </div>;
}

export function CollectorPreparation({ platform }) {
  const [expanded, setExpanded] = useState(false);
  const commands = COMMANDS[platform];
  return <div className="space-y-4 text-sm leading-relaxed text-ink-600">
    <p>수집할 Mac 또는 EC2에서 <code>python3 --version</code>으로 Python 3.9 이상인지 확인하세요.
      Claude Code와 Codex는 별도로 설치되어 있어야 합니다. 다운로드한 압축 파일은 수집할 기기로 옮기세요.</p>
    <p>처음 설치한다면 아래 설치 명령으로 진행하세요. 새 패키지로 이미 설치했다면 같은 명령을 다시 실행해 토큰을 교체할 수 있습니다.</p>
    <div className="rounded-lg border border-ink-200 p-4">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
        className="w-full text-left font-semibold text-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600">
        기존 수집기 전환 안내
      </button>
      {expanded && <div className="mt-3">
        <p><code>local Collector port is occupied</code>는 이전 패키지의 메시지이므로 최신 패키지를 다시 받으세요.
          새 패키지의 <code>occupied by an unverified service</code>는 확인되지 않은 리스너가 있다는 뜻이며,
          <code>cannot check local port</code>는 권한 등으로 검사에 실패했다는 뜻입니다.
          기존 설치 스크립트 <code>setup-test-telemetry-all.sh</code> 또는 <code>setup-test-telemetry.sh</code>를 사용했다면 다음 순서로 전환하세요.</p>
        {platform === "darwin" && <div className="mt-3 rounded-lg bg-brand-50 p-3 text-ink-800">
          <p>설치기가 기존 macOS 수집기를 확인하고 전환을 안내합니다. 최신 패키지로 아래 설치 명령을 실행하세요.</p>
          <p className="mt-2"><code>Migrate this legacy Collector now? [y/N]</code>가 나오면 확인 후 <code>y</code>를 입력하세요.
            새 Collector를 다운로드·검증한 뒤 기존 설정을 비공개 백업하고 전환합니다.
            새 서비스가 시작되지 않으면 기존 상태로 복구합니다.</p>
          <p className="mt-2">먼저 Claude Code·Codex 작업을 종료하고 기존 전송 대기 데이터가 전송되도록 기다리세요.
            기존 대기열은 보존되지만 새 Collector로 가져오지는 않습니다.</p>
        </div>}
        <h3 className="mt-4 font-semibold text-ink-800">{platform === "darwin" ? "자동 인식이 안 될 때 확인" : "1. 기존 서비스 확인"}</h3>
        <GuideCommand key={`inspect-${platform}`} label="기존 서비스 확인 명령" command={commands.inspect} />
        <p>{platform === "darwin"
          ? <>서비스 이름이 <code>com.ccdash.otelcol</code>이고, ProgramArguments의 설정 경로가 본인의 <code>~/.otelcol/config.yaml</code>인지 확인하세요.</>
          : <>서비스 경로가 <code>/etc/systemd/system/otelcol.service</code>이고, ExecStart의 설정 경로가 본인의 <code>~/.otelcol/config.yaml</code>인지 확인하세요.</>}
          {" "}{platform === "linux" && "일치할 때만 다음 중지 명령을 실행하세요. "}
          다른 프로그램이나 관리자가 설치한 수집기는 해당 운영 절차로 전환해야 합니다.</p>
        <p className="mt-2">새 서비스 {platform === "darwin" ? <code>org.ccdash.collector</code> : <code>ccdash-collector.service</code>}가
          이미 동작한다면 기존 서비스 중지 단계는 건너뛰고 설치를 다시 실행하세요.
          서비스가 없다는 오류는 신규 설치에서 정상일 수 있지만, 포트를 사용하는 프로세스가 남아 있으면 진행하지 마세요.</p>
        {platform === "linux" && <>
        <h3 className="mt-4 font-semibold text-ink-800">2. 자동 시작 해제 후 중지</h3>
        <p>Claude Code·Codex 작업을 마치고 종료하세요. 기존 Collector의 전송 오류를 해결하고 대기 데이터가 전송된 후 전환하세요.
          아래 명령은 기존 설정·자격증명·대기 데이터를 삭제하지 않습니다.</p>
        <p className="mt-2">기존 셸 초기화 파일이 수집기를 다시 시작할 수 있어 서비스 파일을 <code>.ccdash-backup</code>으로 보관하고 실행을 차단합니다.
          이미 백업이 있으면 명령이 중단됩니다. 덮어쓰지 말고 이전 전환 상태를 확인하세요.</p>
        <GuideCommand key={`stop-${platform}`} label="기존 서비스 중지 명령" command={commands.stop} />
        <p>포트 조회 명령을 다시 실행해 4317·4318·13133의 리스너가 없는지 확인한 뒤 아래 설치 단계로 진행하세요.
          조회 권한 오류를 빈 결과로 판단하지 마세요. 중지 오류가 나면 설치를 진행하지 말고 서비스 상태를 다시 확인하세요.</p>
        </>}
        <p className="mt-2"><code>~/.otelcol</code>과 기존 LaunchAgent/systemd 파일을 보관하세요.
          기존 셸의 <code>enable-test-telemetry.sh</code>는 사용자·팀 식별값을 유지하므로 이번 전환에서는 그대로 둡니다.
          새 수집기는 기존 전송 대기 데이터를 가져오지 않습니다.</p>
        <details className="mt-4 border-t border-ink-100 pt-3">
          <summary className="cursor-pointer font-medium text-ink-800">수동 복구가 필요할 때</summary>
          {platform === "darwin" && <p className="mt-2">자동 복구가 성공했다면 추가 명령을 실행할 필요가 없습니다.
            자동 복구 실패 메시지가 나왔다면 출력된 비공개 백업의 <code>migration.json</code>을 확인하세요.
            아래 복구 명령은 원래 <code>loaded: true</code>, <code>disabled: false</code>였을 때만 사용합니다.
            그 외 상태는 패키지 README의 복구 절차를 따라 원래 활성화·실행 상태를 유지하세요.</p>}
          <p className="mt-2">새 서비스가 생성되었다면 먼저 아래 명령으로 제거합니다. 파일이 없으면 건너뜁니다.
            제거가 실패하거나 포트에 리스너가 남아 있으면 기존 서비스를 시작하지 마세요.</p>
          <GuideCommand label="새 서비스 제거 명령" command={`python3 ${INSTALL_ROOT} uninstall`} />
          <p>이전에 확인한 기존 서비스만 다시 시작합니다.</p>
          <GuideCommand key={`restore-${platform}`} label="기존 서비스 복구 명령" command={commands.restore} />
          <p>기존 포트는 같으므로 클라이언트를 다시 시작해 수신을 확인하세요.
            클라이언트 설정 자체를 되돌려야 한다면 설치기가 만든 <code>*.ccdash-backup-*</code>를 현재 설정과 비교해 복구하세요.
            더 이상 사용하지 않는 새 기기 토큰은 아래 목록에서 해지하세요.</p>
        </details>
      </div>}
    </div>
    <details className="rounded-lg border border-ink-200 p-4">
      <summary className="cursor-pointer font-semibold text-ink-800">Workshop Studio에서 사전 구성된 EC2를 사용하나요?</summary>
      <p className="mt-3">관리자가 Collector와 클라이언트 설정을 미리 준비한 EC2에서는 참가자가 이 패키지를 추가 설치하거나 기기 토큰을 발급할 필요가 없습니다.
        워크숍 안내에 따라 Claude Code·Codex를 실행하세요. 기존 <code>/etc/otelcol/config.yaml</code>을 사용하는 수집기를 개인용 수집기로 전환하지 마세요.</p>
      <p className="mt-2">현재 워크숍 부팅 템플릿은 SSM SecureString의 ingest 자격증명을 읽어 설치합니다.
        준비되지 않은 EC2는 주최자가 먼저 구성해야 합니다. 개인 Mac에서 직접 수집하려면 이 페이지의 기기 토큰 방식으로 진행하세요.</p>
    </details>
  </div>;
}

export function CollectorVerification({ platform }) {
  return <div className="text-sm leading-relaxed text-ink-600">
    <ol className="list-decimal space-y-2 pl-5">
      <li>새 터미널을 열고 Claude Code와 Codex에서 각각 새 세션을 시작해 실제 작업을 한 번 진행하세요.</li>
      <li>아래 명령으로 로컬 서비스와 설정 상태를 확인하세요.</li>
    </ol>
    <GuideCommand label="설치 상태 확인 명령" command={`python3 ${INSTALL_ROOT} status`} />
    <details className="mb-4 rounded-lg border border-ink-200 p-4">
      <summary className="cursor-pointer font-medium text-ink-800">Codex의 Bedrock 연결 경로도 구분하려면</summary>
      <p className="mt-2">아래 런처는 기존 모델·인증 설정을 유지하면서 확인 가능한 Bedrock 연결 경로를 수집 정보에 추가합니다.
        직접 <code>codex</code>를 실행해도 수집되지만 연결 경로는 미확인으로 표시될 수 있습니다.
        프로필·프로젝트 설정 등으로 경로를 확인할 수 없을 때도 미확인으로 유지합니다.</p>
      <GuideCommand label="Codex 실행 명령" command={'python3 "$HOME/.local/share/ccdash-collector/launch-codex.py"'} />
    </details>
    <p>아래 <strong>내 기기 → 목록 새로고침</strong>에서 최근 수신 시각이 갱신되는지 확인하세요.
      대시보드 기간·사용자·클라이언트 필터를 맞춰 실제 사용량도 확인해야 완료입니다.
      로컬 정상 상태나 최근 수신만으로 데이터베이스 반영·전체 수집이 확인되지는 않습니다.</p>
    <details className="mt-4 rounded-lg border border-ink-200 p-4">
      <summary className="cursor-pointer font-medium text-ink-800">수신이 없거나 설치가 실패했을 때</summary>
      <GuideCommand key={`logs-${platform}`} label="수집기 로그 확인 명령" command={COMMANDS[platform].logs} />
      <ul className="list-disc space-y-2 pl-5">
        <li>포트 충돌: 위의 기존 수집기 전환 안내로 돌아가 실행 중인 서비스를 확인하세요.</li>
        <li>Python을 찾을 수 없음 또는 3.9 미만: Python을 설치·업데이트한 뒤 다시 실행하세요.</li>
        <li>파일을 찾을 수 없음: 압축 파일이 있는 폴더에서 명령을 실행하세요. 브라우저가 이미 압축을 풀었다면 <code>tar</code> 단계를 건너뛰세요.</li>
        <li>토큰 만료·해지 또는 인증 오류: 기기를 새로 등록하고 새 토큰으로 설치를 다시 실행한 뒤 이전 기기를 해지하세요.</li>
        <li>다운로드·연결 오류: 기기에서 GitHub와 대시보드로 HTTPS 연결이 가능한지 확인하세요.</li>
        <li>설정 충돌: 기존 모델·로그인 설정 파일 전체를 삭제하지 마세요. 패키지 README의 설정 충돌 절차를 따르세요.</li>
        {platform === "linux" && <li>systemd 사용자 연결 오류: <code>sudo loginctl enable-linger "$USER"</code> 실행 후 SSH에 다시 로그인하세요.</li>}
      </ul>
    </details>
  </div>;
}
