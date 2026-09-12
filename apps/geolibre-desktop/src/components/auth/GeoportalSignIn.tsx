import { GeoportalLoginError, signInGeoportal, signOutGeoportal } from "@geolibre/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
} from "@geolibre/ui";
import { LogIn, LogOut, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useGeoportalLoginConfig, useGeoportalSession } from "../../hooks/useGeoportalSession";

/**
 * The geoportal's sign-in: a toolbar entry shown only when the deployment
 * names a login service (`LOGIN_SERVICE_URL`). Signed out, it opens a
 * username/password dialog; signed in, it shows the user and offers sign
 * out. The session lives in memory only — the protected services are asked
 * with its header, and a reload starts signed out — as the old geoportal did.
 */
export function GeoportalSignIn() {
  const { t } = useTranslation();
  const config = useGeoportalLoginConfig();
  const session = useGeoportalSession();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  if (!config) return null;

  const close = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false);
    setBusy(false);
    setError(null);
    setPassword("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const name = username.trim();
    if (!name || !password) {
      setError(t("geoportalSignIn.missingCredentials"));
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      await signInGeoportal(config, name, password, fetch, controller.signal);
      if (controller.signal.aborted) return;
      close();
    } catch (cause) {
      if (controller.signal.aborted) return;
      const reason = cause instanceof GeoportalLoginError ? cause.reason : "generic";
      setError(
        reason === "invalid-credentials"
          ? t("geoportalSignIn.invalidCredentials")
          : reason === "connection"
            ? t("geoportalSignIn.connectionError")
            : t("geoportalSignIn.genericError"),
      );
      setBusy(false);
    }
  };

  if (session.username) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            size="sm"
            variant="ghost"
            data-testid="geoportal-account"
            title={t("geoportalSignIn.signedInAs", { name: session.username })}
          >
            <UserRound className="h-3.5 w-3.5" />
            <span className="hidden max-w-32 truncate sm:inline">{session.username}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {t("geoportalSignIn.signedInAs", { name: session.username })}
            {session.profile ? (
              <span className="block text-foreground">
                {t("geoportalSignIn.profile", { profile: session.profile })}
              </span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => signOutGeoportal()}>
            <LogOut className="me-2 h-3.5 w-3.5" />
            {t("geoportalSignIn.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <>
      <Button
        className="h-7 shrink-0 gap-1 px-2 text-xs"
        size="sm"
        variant="ghost"
        data-testid="geoportal-sign-in"
        onClick={() => setOpen(true)}
        title={t("geoportalSignIn.signIn")}
      >
        <LogIn className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t("geoportalSignIn.signIn")}</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("geoportalSignIn.title")}</DialogTitle>
            <DialogDescription>{t("geoportalSignIn.description")}</DialogDescription>
          </DialogHeader>
          <form className="space-y-3" onSubmit={(event) => void submit(event)}>
            <div className="space-y-1">
              <Label htmlFor="geoportal-username">{t("geoportalSignIn.username")}</Label>
              <Input
                id="geoportal-username"
                autoComplete="username"
                autoFocus
                disabled={busy}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="geoportal-password">{t("geoportalSignIn.password")}</Label>
              <Input
                id="geoportal-password"
                type="password"
                autoComplete="current-password"
                disabled={busy}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t("geoportalSignIn.signingIn") : t("geoportalSignIn.signIn")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
