//! Accounts and roles, through the real message API rather than the module underneath it.
//!
//! `auth.rs` proves the rules in isolation; these prove they are actually reached. The gap
//! between "the matrix says no" and "the dispatch asks the matrix" is exactly where an
//! authorisation bug lives, so every case here goes through `Core::handle`.

mod support;

use espro_core::auth::Edition;
use espro_core::Core;
use serde_json::{json, Value};
use support::TempDir;

const PASSWORD: &str = "correct-horse-battery";

fn core(dir: &TempDir, edition: Edition) -> std::sync::Arc<Core> {
    Core::new_with_rounds(Some(dir.0.clone()), edition, 1)
}

/// Create the first admin and return a live session token.
async fn admin_session(c: &std::sync::Arc<Core>) -> String {
    let res = c
        .handle(json!({ "type": "BOOTSTRAP_ADMIN", "name": "root", "password": PASSWORD }))
        .await;
    assert_eq!(res["ok"], json!(true), "bootstrap failed: {res}");
    res["session"].as_str().expect("a session").to_string()
}

async fn login(c: &std::sync::Arc<Core>, name: &str) -> String {
    let res = c.handle(json!({ "type": "LOGIN", "name": name, "password": PASSWORD })).await;
    assert_eq!(res["ok"], json!(true), "login failed for {name}: {res}");
    res["session"].as_str().expect("a session").to_string()
}

async fn add(c: &std::sync::Arc<Core>, admin: &str, name: &str, role: &str) -> Value {
    c.handle(json!({ "type": "USER_ADD", "session": admin, "name": name, "password": PASSWORD, "role": role }))
        .await
}

/* --------------------------------- portable --------------------------------- */

#[tokio::test]
async fn portable_never_asks_anyone_to_log_in() {
    let dir = TempDir::new("auth-portable");
    let c = core(&dir, Edition::Portable);

    let ping = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(ping["authRequired"], json!(false));
    assert_eq!(ping["needsBootstrap"], json!(false));

    // Admin-only message types are open, because there are no roles at all.
    for t in ["CONFIG_READ", "PINS", "REQUEST_STATS"] {
        let res = c.handle(json!({ "type": t, "path": "" })).await;
        assert_ne!(res["kind"], json!("unauthenticated"), "{t} must not need a session in portable");
        assert_ne!(res["kind"], json!("forbidden"), "{t} must not be gated in portable");
        assert_ne!(res["kind"], json!("needs_bootstrap"), "{t} must not want a bootstrap in portable");
    }
}

#[tokio::test]
async fn portable_writes_no_accounts_file() {
    let dir = TempDir::new("auth-noaccounts");
    let c = core(&dir, Edition::Portable);
    let _ = c.handle(json!({ "type": "PING" })).await;
    assert!(
        !dir.0.join("users.json").exists(),
        "portable must not create an accounts file"
    );
}

/* -------------------------------- bootstrap --------------------------------- */

#[tokio::test]
async fn an_installed_build_demands_a_first_admin_before_anything_else() {
    let dir = TempDir::new("auth-bootstrap");
    let c = core(&dir, Edition::Installed);

    let ping = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(ping["authRequired"], json!(true));
    assert_eq!(ping["needsBootstrap"], json!(true));

    // Nothing useful works yet, and the refusal says what to do about it.
    let res = c.handle(json!({ "type": "CONFIG_READ", "path": "x" })).await;
    assert_eq!(res["kind"], json!("needs_bootstrap"), "{res}");

    let session = admin_session(&c).await;
    let after = c.handle(json!({ "type": "PING" })).await;
    assert_eq!(after["needsBootstrap"], json!(false));

    let who = c.handle(json!({ "type": "WHOAMI", "session": session })).await;
    assert_eq!(who["caller"]["name"], json!("root"));
    assert_eq!(who["caller"]["role"], json!("admin"));
}

#[tokio::test]
async fn bootstrap_is_only_available_while_there_are_no_accounts() {
    let dir = TempDir::new("auth-rebootstrap");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;

    // The obvious privilege escalation: call it again and get a second admin. It is
    // refused twice over — the session gate stops it before the handler is reached,
    // because BOOTSTRAP_ADMIN is not in the no-session list once accounts exist...
    let anon = c
        .handle(json!({ "type": "BOOTSTRAP_ADMIN", "name": "mallory", "password": PASSWORD }))
        .await;
    assert_eq!(anon["ok"], json!(false), "{anon}");
    assert_eq!(anon["kind"], json!("unauthenticated"), "{anon}");

    // ...and the handler refuses it too, so an admin session is no way in either.
    let with_admin = c
        .handle(json!({ "type": "BOOTSTRAP_ADMIN", "session": admin, "name": "mallory", "password": PASSWORD }))
        .await;
    assert_eq!(with_admin["ok"], json!(false), "{with_admin}");
    assert_eq!(with_admin["kind"], json!("forbidden"), "{with_admin}");

    // Either way, no second account exists.
    let listed = c.handle(json!({ "type": "USER_LIST", "session": admin })).await;
    assert_eq!(listed["users"].as_array().unwrap().len(), 1, "{listed}");
}

#[tokio::test]
async fn a_short_password_is_refused_at_bootstrap() {
    let dir = TempDir::new("auth-weak");
    let c = core(&dir, Edition::Installed);
    let res = c.handle(json!({ "type": "BOOTSTRAP_ADMIN", "name": "root", "password": "abc" })).await;
    assert_eq!(res["ok"], json!(false));
    assert!(res["message"].as_str().unwrap().contains("at least"), "{res}");
}

/* ---------------------------------- sessions --------------------------------- */

#[tokio::test]
async fn no_session_means_nothing_but_the_public_messages() {
    let dir = TempDir::new("auth-nosession");
    let c = core(&dir, Edition::Installed);
    admin_session(&c).await;

    for t in ["CONFIG_READ", "WRITE_UNLOCK", "PINS", "USER_LIST"] {
        let res = c.handle(json!({ "type": t })).await;
        assert_eq!(res["kind"], json!("unauthenticated"), "{t} leaked without a session: {res}");
    }
    // PING still answers, or the UI could never discover it needs to log in.
    assert_eq!(c.handle(json!({ "type": "PING" })).await["ok"], json!(true));
}

#[tokio::test]
async fn a_bad_password_says_nothing_about_which_half_was_wrong() {
    let dir = TempDir::new("auth-badpw");
    let c = core(&dir, Edition::Installed);
    admin_session(&c).await;

    let wrong_pw = c.handle(json!({ "type": "LOGIN", "name": "root", "password": "nope" })).await;
    let no_user = c.handle(json!({ "type": "LOGIN", "name": "ghost", "password": "nope" })).await;
    assert_eq!(wrong_pw["ok"], json!(false));
    assert_eq!(no_user["ok"], json!(false));
    assert_eq!(
        wrong_pw["message"], no_user["message"],
        "a wrong password and a missing account must be indistinguishable"
    );
}

#[tokio::test]
async fn logging_out_ends_the_session() {
    let dir = TempDir::new("auth-logout");
    let c = core(&dir, Edition::Installed);
    let s = admin_session(&c).await;
    assert_eq!(c.handle(json!({ "type": "USER_LIST", "session": s })).await["ok"], json!(true));
    c.handle(json!({ "type": "LOGOUT", "session": s })).await;
    assert_eq!(
        c.handle(json!({ "type": "USER_LIST", "session": s })).await["kind"],
        json!("unauthenticated")
    );
}

/* ------------------------------------ roles ----------------------------------- */

#[tokio::test]
async fn a_user_can_read_a_cluster_but_not_write_or_administer() {
    let dir = TempDir::new("auth-user");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    assert_eq!(add(&c, &admin, "reader", "user").await["ok"], json!(true));
    let s = login(&c, "reader").await;

    // Reads reach the cluster layer — "not primed" is the transport talking, which means
    // authorisation let it through.
    let read = c
        .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": "/_cat/indices" }))
        .await;
    assert_ne!(read["kind"], json!("forbidden"), "a user must be able to read indices: {read}");

    for (method, path) in [("DELETE", "/logstash-2026.01.01"), ("PUT", "/idx"), ("POST", "/idx/_doc")] {
        let res = c
            .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": method, "path": path }))
            .await;
        assert_eq!(res["kind"], json!("forbidden"), "{method} {path} must be refused for a user: {res}");
    }
    for t in ["WRITE_UNLOCK", "CONFIG_READ", "CONFIG_WRITE", "USER_LIST", "TRUST_CERT", "VAULT_GET", "PRIME"] {
        let res = c.handle(json!({ "type": t, "session": s })).await;
        assert_eq!(res["kind"], json!("forbidden"), "{t} must be refused for a user: {res}");
    }
}

#[tokio::test]
async fn a_guest_sees_health_and_no_index_names() {
    let dir = TempDir::new("auth-guest");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    assert_eq!(add(&c, &admin, "visitor", "guest").await["ok"], json!(true));
    let s = login(&c, "visitor").await;

    for p in ["/_cluster/health", "/_cat/nodes", "/_nodes/stats/fs"] {
        let res = c
            .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": p }))
            .await;
        assert_ne!(res["kind"], json!("forbidden"), "a guest should see {p}: {res}");
    }
    for p in ["/_cat/indices", "/_snapshot/repo/_all", "/logstash-*/_search", "/_ilm/explain"] {
        let res = c
            .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": p }))
            .await;
        assert_eq!(res["kind"], json!("forbidden"), "a guest must not see {p}: {res}");
    }
    // Nor the pages that name hosts and jump hosts.
    for t in ["TUNNELS", "PINS", "REQUEST_STATS"] {
        assert_eq!(
            c.handle(json!({ "type": t, "session": s })).await["kind"],
            json!("forbidden"),
            "{t} must be refused for a guest"
        );
    }
}

#[tokio::test]
async fn an_admin_can_do_the_things_the_others_cannot() {
    let dir = TempDir::new("auth-admin");
    let c = core(&dir, Edition::Installed);
    let s = admin_session(&c).await;

    for t in ["USER_LIST", "PINS", "REQUEST_STATS", "TUNNELS"] {
        let res = c.handle(json!({ "type": t, "session": s })).await;
        assert_eq!(res["ok"], json!(true), "{t} should work for an admin: {res}");
    }
    let unlock = c.handle(json!({ "type": "WRITE_UNLOCK", "session": s, "on": true })).await;
    assert_ne!(unlock["kind"], json!("forbidden"));
}

/* ------------------------------ account management ----------------------------- */

#[tokio::test]
async fn an_admin_cannot_lock_everyone_out() {
    let dir = TempDir::new("auth-lastadmin");
    let c = core(&dir, Edition::Installed);
    let s = admin_session(&c).await;

    let demote = c
        .handle(json!({ "type": "USER_SET_ROLE", "session": s, "name": "root", "role": "user" }))
        .await;
    assert_eq!(demote["ok"], json!(false), "the only admin must not be able to demote themselves");

    let remove = c.handle(json!({ "type": "USER_REMOVE", "session": s, "name": "root" })).await;
    assert_eq!(remove["ok"], json!(false), "nor remove themselves");
}

#[tokio::test]
async fn changing_someones_role_ends_their_session_at_once() {
    let dir = TempDir::new("auth-demote");
    let c = core(&dir, Edition::Installed);
    let admin = admin_session(&c).await;
    add(&c, &admin, "reader", "user").await;
    let s = login(&c, "reader").await;

    // Live before, gone after — a demotion that waits for a logout is not a demotion.
    let before = c
        .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": "/_cat/indices" }))
        .await;
    assert_ne!(before["kind"], json!("forbidden"));

    c.handle(json!({ "type": "USER_SET_ROLE", "session": admin, "name": "reader", "role": "guest" })).await;
    let after = c
        .handle(json!({ "type": "ES", "session": s, "clusterId": "x", "method": "GET", "path": "/_cat/indices" }))
        .await;
    assert_eq!(after["kind"], json!("unauthenticated"), "the old session must not survive: {after}");
}

#[tokio::test]
async fn accounts_and_roles_survive_a_restart() {
    let dir = TempDir::new("auth-restart");
    {
        let c = core(&dir, Edition::Installed);
        let admin = admin_session(&c).await;
        add(&c, &admin, "reader", "user").await;
    }
    // A fresh Core over the same data dir: same accounts, no bootstrap, sessions gone.
    let c2 = core(&dir, Edition::Installed);
    assert_eq!(c2.handle(json!({ "type": "PING" })).await["needsBootstrap"], json!(false));
    let s = login(&c2, "reader").await;
    let who = c2.handle(json!({ "type": "WHOAMI", "session": s })).await;
    assert_eq!(who["caller"]["role"], json!("user"));
}

#[tokio::test]
async fn the_accounts_file_never_holds_a_password() {
    let dir = TempDir::new("auth-nopw");
    let c = core(&dir, Edition::Installed);
    admin_session(&c).await;
    let raw = std::fs::read_to_string(dir.0.join("users.json")).expect("accounts file");
    assert!(!raw.contains(PASSWORD), "the password is in users.json: {raw}");
}

/* ---------------------------- hosted, and its upgrade --------------------------- */

#[tokio::test]
async fn a_hosted_deployment_keeps_working_until_someone_creates_an_account() {
    let dir = TempDir::new("auth-hosted-upgrade");
    let c = core(&dir, Edition::Hosted);

    // Before any account exists the proxy's word is taken, exactly as it was before this
    // feature. Upgrading must not lock a team out of their monitoring.
    let before = c.caller_for_proxy_user("alice").expect("the proxy's word should be enough");
    assert_eq!(before.role, espro_core::auth::Role::Admin);
    assert_eq!(
        c.handle(json!({ "type": "PING" })).await["needsBootstrap"],
        json!(true),
        "but it should keep saying that accounts are not set up"
    );
    // Unlike an install, nothing is blocked meanwhile.
    let res = c.handle_as(json!({ "type": "PINS" }), Some(before)).await;
    assert_eq!(res["ok"], json!(true), "hosted must not block before bootstrap: {res}");

    // The moment an account exists, the proxy's word is only as good as the account.
    admin_session(&c).await;
    assert!(
        c.caller_for_proxy_user("alice").is_none(),
        "once accounts exist, a proxy name with no account is nobody"
    );
    assert_eq!(
        c.caller_for_proxy_user("root").expect("root has an account").role,
        espro_core::auth::Role::Admin
    );
}

#[tokio::test]
async fn a_disabled_account_is_not_let_in_by_the_proxy_either() {
    let dir = TempDir::new("auth-hosted-disabled");
    let c = core(&dir, Edition::Hosted);
    let admin = admin_session(&c).await;
    add(&c, &admin, "reader", "user").await;
    assert!(c.caller_for_proxy_user("reader").is_some());

    c.handle(json!({ "type": "USER_SET_ROLE", "session": admin, "name": "reader", "role": "guest" })).await;
    assert_eq!(
        c.caller_for_proxy_user("reader").expect("still an account").role,
        espro_core::auth::Role::Guest,
        "the proxy path must read the current role, not a cached one"
    );
}

/* -------------------------------- api tokens --------------------------------- */

#[tokio::test]
async fn the_desktop_build_says_why_it_has_no_api_tokens() {
    let dir = TempDir::new("auth-notokens");
    let c = core(&dir, Edition::Installed);
    let s = admin_session(&c).await;
    let res = c.handle(json!({ "type": "TOKEN_CREATE", "session": s, "name": "zabbix", "role": "guest" })).await;
    assert_eq!(res["ok"], json!(false));
    assert_eq!(res["kind"], json!("unsupported"));
    assert!(res["message"].as_str().unwrap().contains("hosted"), "{res}");
}

#[tokio::test]
async fn a_hosted_token_works_and_carries_its_role() {
    let dir = TempDir::new("auth-tokens");
    let c = core(&dir, Edition::Hosted);
    let s = admin_session(&c).await;

    let made = c
        .handle(json!({ "type": "TOKEN_CREATE", "session": s, "name": "zabbix", "role": "guest" }))
        .await;
    assert_eq!(made["ok"], json!(true), "{made}");
    let secret = made["secret"].as_str().expect("a secret").to_string();
    assert!(secret.starts_with("espro_"));

    // The token resolves to a caller, and that caller is bound by its role like anyone.
    let caller = c.caller_for_token(&secret).expect("the token should resolve");
    let health = c
        .handle_as(
            json!({ "type": "ES", "clusterId": "x", "method": "GET", "path": "/_cluster/health" }),
            Some(caller.clone()),
        )
        .await;
    assert_ne!(health["kind"], json!("forbidden"));
    let indices = c
        .handle_as(
            json!({ "type": "ES", "clusterId": "x", "method": "GET", "path": "/_cat/indices" }),
            Some(caller),
        )
        .await;
    assert_eq!(indices["kind"], json!("forbidden"), "a guest token must stay a guest: {indices}");

    // Revoked means revoked.
    let id = made["tokens"][0]["id"].as_str().unwrap().to_string();
    c.handle(json!({ "type": "TOKEN_REVOKE", "session": s, "id": id })).await;
    assert!(c.caller_for_token(&secret).is_none(), "a revoked token must stop resolving");
}

#[tokio::test]
async fn an_api_token_can_never_be_an_admin() {
    let dir = TempDir::new("auth-adm-token");
    let c = core(&dir, Edition::Hosted);
    let s = admin_session(&c).await;
    let res = c
        .handle(json!({ "type": "TOKEN_CREATE", "session": s, "name": "everything", "role": "admin" }))
        .await;
    assert_eq!(res["ok"], json!(false), "an admin token would be an unattended index deleter: {res}");
}

#[tokio::test]
async fn the_token_secret_is_shown_once_and_not_stored() {
    let dir = TempDir::new("auth-tok-once");
    let c = core(&dir, Edition::Hosted);
    let s = admin_session(&c).await;
    let made = c.handle(json!({ "type": "TOKEN_CREATE", "session": s, "name": "zabbix", "role": "user" })).await;
    let secret = made["secret"].as_str().unwrap().to_string();

    let listed = c.handle(json!({ "type": "TOKEN_LIST", "session": s })).await;
    assert!(!listed.to_string().contains(&secret), "listing must not repeat the secret");
    let raw = std::fs::read_to_string(dir.0.join("tokens.json")).expect("tokens file");
    assert!(!raw.contains(&secret), "the secret must not be on disk");
}
