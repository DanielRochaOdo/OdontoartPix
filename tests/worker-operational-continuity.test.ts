import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deploy = readFileSync("deploy/production/docker-safe-deploy.sh", "utf8");
const monitor = readFileSync("deploy/production/worker-watchdog.py", "utf8");
const installer = readFileSync("deploy/production/install-worker-watchdog.sh", "utf8");

describe("contratos operacionais do worker Docker", () => {
  it("constroi e valida antes de parar o timer", () => {
    expect(deploy.indexOf("docker build")).toBeGreaterThan(0);
    expect(deploy.indexOf("docker build")).toBeLessThan(
      deploy.indexOf('systemctl stop "${TIMER}"')
    );
    expect(deploy).toContain("run db:migrate");
    expect(deploy).toContain("run preflight:production");
    expect(deploy).toContain("ensure_idle");
    expect(deploy).toContain('[[ "${n}" =~ ^[0-9]+$ ]]');
    // O bloqueio deve ocorrer ANTES de gerar a nova imagem, sem carga
    // de build extra sobre a sincronizacao que continua ativa.
    expect(deploy.indexOf("\nensure_idle\n")).toBeLessThan(deploy.indexOf("docker build"));
    expect(deploy).toContain("trap cleanup EXIT");
  });

  it("protege o banco, so recria app e mantem o marcador antes da parada", () => {
    expect(deploy).not.toMatch(/docker compose\s+down/);
    expect(deploy).toContain("up -d --no-deps --no-build --force-recreate app");
    expect(deploy).toContain("docker exec odontopix-db-1");
    expect(deploy.indexOf('mkdir "${MAINT}"')).toBeLessThan(
      deploy.indexOf('systemctl stop "${TIMER}"')
    );
    expect(deploy).toContain("SAFE_DEPLOY_ROLLBACK_OK");
  });

  it("watchdog nao recupera timer desabilitado, em manutencao ou sem health", () => {
    expect(monitor).toContain("timer_is_enabled");
    expect(monitor).toContain("self.maintenance.exists()");
    expect(monitor).toContain("self.health()");
    expect(monitor).toContain("timer_recovery_blocked");
    expect(monitor).toContain("sync_without_progress");
    expect(monitor).not.toContain("docker compose up");
  });

  it("instala o watchdog independentemente do contêiner e sem autoativacao implicita", () => {
    expect(installer).toContain("install -Dm 0755");
    expect(installer).toContain("ENABLE_WATCHDOG:-false");
    expect(installer).toContain("OnUnitInactiveSec=60s");
  });
});
