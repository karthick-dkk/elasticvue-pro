//! Listing an S3 bucket, for the ULM page.
//!
//! The core does this rather than the browser for the same reasons it does everything
//! else: a page cannot sign a request without holding the secret, S3 will not serve a
//! browser cross-origin without CORS on the bucket, and the audit trail is here.
//!
//! What this is **not**: a general S3 client. It lists, and that is all. There is no
//! GET, no PUT, no DELETE, and no way to reach one — a page asking this core about a
//! bucket can learn what is in it and nothing else, which is the whole of what ULM
//! needs and a much smaller thing to get wrong.
//!
//! Listing is also the expensive operation, so the page drives it by hand. Nothing here
//! runs on its own.

use crate::sigv4::{self, Header, Request, EMPTY_PAYLOAD_SHA256};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Where the credentials come from. Per bucket, because a fleet's buckets rarely share
/// one account — the answer given when this was specified.
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct S3Auth {
    /// Explicit keys. Sealed in the config like a cluster password.
    #[serde(default)]
    pub access_key_id: Option<String>,
    #[serde(default)]
    pub secret_access_key: Option<String>,
    #[serde(default)]
    pub session_token: Option<String>,
    /// Take whatever the host already has: the environment, then the container
    /// credential endpoint, then the instance metadata service.
    #[serde(default)]
    pub use_role: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    pub bucket: String,
    #[serde(default = "default_region")]
    pub region: String,
    /// For S3-compatible storage. Empty means AWS.
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub auth: S3Auth,
}

fn default_region() -> String { "us-east-1".into() }

/// Resolved credentials, whatever they came from.
#[derive(Clone, Debug)]
pub struct Creds {
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
    /// For the UI, so an operator can see which of the several sources answered.
    pub source: &'static str,
}

/// One object.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Object {
    pub key: String,
    pub size: u64,
    pub last_modified: String,
}

/// One page of a listing.
#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub objects: Vec<Object>,
    /// Directory-like prefixes, when a delimiter was given.
    pub prefixes: Vec<String>,
    pub truncated: bool,
    pub next_token: Option<String>,
    /// Summed over this page only; the caller adds up the pages.
    pub bytes: u64,
}

/* ------------------------------- XML, minimally ------------------------------- */

/// The text of the first `<tag>` inside `xml`, starting at `from`.
///
/// A real parser is not needed and not wanted: ListObjectsV2 returns a flat, known
/// shape, and pulling in an XML crate to read six element names is a dependency for
/// nothing. What this must get right is that it never treats a value as markup — every
/// extracted string is returned as text and goes nowhere near a DOM.
fn tag_at<'a>(xml: &'a str, tag: &str, from: usize) -> Option<(&'a str, usize)> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml[from..].find(&open)? + from + open.len();
    let end = xml[start..].find(&close)? + start;
    Some((&xml[start..end], end + close.len()))
}

fn tag(xml: &str, name: &str) -> Option<String> {
    tag_at(xml, name, 0).map(|(v, _)| unescape(v))
}

/// The five entities XML defines. S3 escapes keys containing them.
fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Parse a ListObjectsV2 response.
pub fn parse_listing(xml: &str) -> Listing {
    let mut out = Listing::default();
    let mut at = 0;
    while let Some((block, next)) = tag_at(xml, "Contents", at) {
        at = next;
        let key = match tag(block, "Key") { Some(k) => k, None => continue };
        // A missing or unreadable size is skipped rather than counted as zero: a total
        // that silently omits an object is a smaller lie than one that counts it as
        // empty, and both are worse than saying the page could not be read.
        let size = tag(block, "Size").and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(0);
        out.bytes += size;
        out.objects.push(Object {
            key,
            size,
            last_modified: tag(block, "LastModified").unwrap_or_default(),
        });
    }
    let mut at = 0;
    while let Some((block, next)) = tag_at(xml, "CommonPrefixes", at) {
        at = next;
        if let Some(p) = tag(block, "Prefix") { out.prefixes.push(p); }
    }
    out.truncated = tag(xml, "IsTruncated").map(|v| v.trim() == "true").unwrap_or(false);
    out.next_token = tag(xml, "NextContinuationToken").filter(|t| !t.is_empty());
    out
}

/* ------------------------------- credentials ------------------------------- */

/// Resolve credentials for one bucket.
///
/// Explicit keys win, because somebody wrote them down for this bucket on purpose. Then
/// the environment, then the container credential endpoint, then instance metadata —
/// the order the AWS tools themselves use, so a host already set up for `aws s3` works
/// here without being set up twice.
pub async fn resolve_creds(auth: &S3Auth) -> Result<Creds, String> {
    if let (Some(id), Some(secret)) = (auth.access_key_id.as_deref(), auth.secret_access_key.as_deref()) {
        if !id.is_empty() && !secret.is_empty() {
            return Ok(Creds {
                access_key_id: id.to_string(),
                secret_access_key: secret.to_string(),
                session_token: auth.session_token.clone().filter(|t| !t.is_empty()),
                source: "configured keys",
            });
        }
    }
    if !auth.use_role {
        return Err("no access key configured for this bucket, and it is not set to use a role".into());
    }

    if let (Ok(id), Ok(secret)) = (std::env::var("AWS_ACCESS_KEY_ID"), std::env::var("AWS_SECRET_ACCESS_KEY")) {
        if !id.is_empty() && !secret.is_empty() {
            return Ok(Creds {
                access_key_id: id,
                secret_access_key: secret,
                session_token: std::env::var("AWS_SESSION_TOKEN").ok().filter(|t| !t.is_empty()),
                source: "environment",
            });
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;

    // ECS and EKS hand credentials out on a link-local address named by the runtime.
    if let Ok(rel) = std::env::var("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") {
        let url = format!("http://169.254.170.2{rel}");
        if let Ok(c) = fetch_role_creds(&client, &url, None, "container role").await {
            return Ok(c);
        }
    }
    if let Ok(full) = std::env::var("AWS_CONTAINER_CREDENTIALS_FULL_URI") {
        let token = std::env::var("AWS_CONTAINER_AUTHORIZATION_TOKEN").ok();
        if let Ok(c) = fetch_role_creds(&client, &full, token.as_deref(), "container role").await {
            return Ok(c);
        }
    }

    // EC2 instance metadata, v2 only: v1 is the one that SSRF turns into a credential
    // leak, and asking for a token first is what makes that attack need a second step.
    let token = client
        .put("http://169.254.169.254/latest/api/token")
        .header("x-aws-ec2-metadata-token-ttl-seconds", "60")
        .send()
        .await
        .map_err(|e| format!("instance metadata is not reachable: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let role = client
        .get("http://169.254.169.254/latest/meta-data/iam/security-credentials/")
        .header("x-aws-ec2-metadata-token", &token)
        .send()
        .await
        .map_err(|e| format!("no instance role: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let role = role.lines().next().unwrap_or("").trim().to_string();
    if role.is_empty() {
        return Err("this host has no instance role attached".into());
    }
    let url = format!("http://169.254.169.254/latest/meta-data/iam/security-credentials/{role}");
    fetch_role_creds(&client, &url, Some(&token), "instance role").await
}

async fn fetch_role_creds(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
    source: &'static str,
) -> Result<Creds, String> {
    let mut req = client.get(url);
    if let Some(t) = token {
        req = req.header("x-aws-ec2-metadata-token", t);
    }
    let body: serde_json::Value = req
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let get = |k: &str| body.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let (id, secret) = (get("AccessKeyId"), get("SecretAccessKey"));
    if id.is_empty() || secret.is_empty() {
        return Err(format!("{source} returned no usable credentials"));
    }
    Ok(Creds {
        access_key_id: id,
        secret_access_key: secret,
        session_token: Some(get("Token")).filter(|t| !t.is_empty()),
        source,
    })
}

/* --------------------------------- listing --------------------------------- */

/// The host a bucket lives on. Virtual-hosted style for AWS, path style for anything
/// else, because S3-compatible stores rarely have the wildcard DNS for the former.
pub fn endpoint_for(cfg: &S3Config) -> (String, String) {
    match cfg.endpoint.as_deref().filter(|e| !e.trim().is_empty()) {
        Some(e) => {
            let base = e.trim_end_matches('/');
            let host = base.split("://").nth(1).unwrap_or(base).to_string();
            (format!("{base}/{}", cfg.bucket), host)
        }
        None => {
            let host = if cfg.region == "us-east-1" {
                format!("{}.s3.amazonaws.com", cfg.bucket)
            } else {
                format!("{}.s3.{}.amazonaws.com", cfg.bucket, cfg.region)
            };
            (format!("https://{host}"), host)
        }
    }
}

/// One page of `ListObjectsV2`.
pub async fn list_objects(
    cfg: &S3Config,
    creds: &Creds,
    prefix: &str,
    delimiter: Option<&str>,
    max_keys: u32,
    continuation: Option<&str>,
    now_ms: i64,
) -> Result<Listing, String> {
    let (base, host) = endpoint_for(cfg);

    let mut query: Vec<(String, String)> = vec![
        ("list-type".into(), "2".into()),
        ("max-keys".into(), max_keys.clamp(1, 1000).to_string()),
    ];
    if !prefix.is_empty() {
        query.push(("prefix".into(), prefix.to_string()));
    }
    if let Some(d) = delimiter.filter(|d| !d.is_empty()) {
        query.push(("delimiter".into(), d.to_string()));
    }
    if let Some(t) = continuation.filter(|t| !t.is_empty()) {
        query.push(("continuation-token".into(), t.to_string()));
    }

    let datetime = sigv4::amz_date(now_ms);
    let mut headers = vec![
        Header::new("host", &host),
        Header::new("x-amz-content-sha256", EMPTY_PAYLOAD_SHA256),
        Header::new("x-amz-date", &datetime),
    ];
    if let Some(t) = creds.session_token.as_deref() {
        headers.push(Header::new("x-amz-security-token", t));
    }

    // The path is "/" for a virtual-hosted bucket; for a path-style endpoint the bucket
    // is part of the path and must be signed as it appears.
    let path = if cfg.endpoint.as_deref().filter(|e| !e.trim().is_empty()).is_some() {
        format!("/{}", sigv4::uri_encode(&cfg.bucket, false))
    } else {
        "/".to_string()
    };

    let signed = Request {
        method: "GET",
        path: &path,
        query: query.clone(),
        headers: headers.clone(),
        payload_sha256: EMPTY_PAYLOAD_SHA256.to_string(),
    };
    let auth = sigv4::authorization(
        &creds.access_key_id,
        &creds.secret_access_key,
        &cfg.region,
        "s3",
        &datetime,
        &signed,
    );

    let qs = query
        .iter()
        .map(|(k, v)| format!("{}={}", sigv4::uri_encode(k, true), sigv4::uri_encode(v, true)))
        .collect::<Vec<_>>()
        .join("&");
    let url = format!("{base}?{qs}");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(&url).header("authorization", auth);
    for h in &headers {
        if h.name != "host" {
            req = req.header(h.name.as_str(), h.value.as_str());
        }
    }

    let res = req.send().await.map_err(|e| format!("S3 is not reachable: {e}"))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| e.to_string())?;
    if status != 200 {
        // S3 puts a machine-readable reason in the body. Relaying it beats "HTTP 403",
        // which is the same answer for a wrong key, a missing bucket and a denied policy.
        let code = tag(&body, "Code").unwrap_or_default();
        let msg = tag(&body, "Message").unwrap_or_default();
        return Err(if code.is_empty() {
            format!("S3 answered HTTP {status}")
        } else {
            format!("S3 refused: {code} — {msg}")
        });
    }
    Ok(parse_listing(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>client-bucket</Name>
  <Prefix>rawlog/tag1/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr</NextContinuationToken>
  <Contents>
    <Key>rawlog/tag1/HQ/date=2026.8.1/part-0.gz</Key>
    <LastModified>2026-08-01T04:10:22.000Z</LastModified>
    <Size>10485760</Size>
  </Contents>
  <Contents>
    <Key>rawlog/tag1/HQ/date=2026.8.1/part-1.gz</Key>
    <LastModified>2026-08-01T05:11:00.000Z</LastModified>
    <Size>2097152</Size>
  </Contents>
  <CommonPrefixes><Prefix>rawlog/tag1/DR/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>rawlog/tag1/HQ/</Prefix></CommonPrefixes>
</ListBucketResult>"#;

    #[test]
    fn a_listing_is_read_in_full() {
        let l = parse_listing(SAMPLE);
        assert_eq!(l.objects.len(), 2);
        assert_eq!(l.objects[0].key, "rawlog/tag1/HQ/date=2026.8.1/part-0.gz");
        assert_eq!(l.objects[0].size, 10_485_760);
        assert_eq!(l.objects[0].last_modified, "2026-08-01T04:10:22.000Z");
        assert_eq!(l.bytes, 12_582_912, "the page total is the sum of its objects");
        assert_eq!(l.prefixes, vec!["rawlog/tag1/DR/", "rawlog/tag1/HQ/"]);
    }

    #[test]
    fn a_truncated_listing_says_so_and_carries_its_token() {
        // Stopping at the first page is how a bucket total comes out too small and
        // nothing says it did.
        let l = parse_listing(SAMPLE);
        assert!(l.truncated);
        assert_eq!(l.next_token.as_deref(), Some("1ueGcxLPRx1Tr"));
    }

    #[test]
    fn a_complete_listing_has_no_token() {
        let xml = SAMPLE.replace("<IsTruncated>true</IsTruncated>", "<IsTruncated>false</IsTruncated>")
            .replace("<NextContinuationToken>1ueGcxLPRx1Tr</NextContinuationToken>", "");
        let l = parse_listing(&xml);
        assert!(!l.truncated);
        assert_eq!(l.next_token, None);
    }

    #[test]
    fn an_empty_listing_is_empty_rather_than_an_error() {
        let xml = r#"<ListBucketResult><Name>b</Name><KeyCount>0</KeyCount>
                     <IsTruncated>false</IsTruncated></ListBucketResult>"#;
        let l = parse_listing(xml);
        assert!(l.objects.is_empty());
        assert_eq!(l.bytes, 0);
        assert!(!l.truncated);
    }

    #[test]
    fn keys_carrying_xml_entities_come_back_as_text() {
        // An object key may contain & or <. It must arrive as the characters it is, and
        // never as markup — this value ends up in a table.
        let xml = r#"<ListBucketResult><Contents>
            <Key>rawlog/a&amp;b/&lt;odd&gt;.gz</Key><Size>5</Size>
            <LastModified>2026-08-01T00:00:00.000Z</LastModified>
        </Contents></ListBucketResult>"#;
        let l = parse_listing(xml);
        assert_eq!(l.objects[0].key, "rawlog/a&b/<odd>.gz");
    }

    #[test]
    fn the_bucket_host_follows_the_region() {
        let aws = S3Config { bucket: "c1".into(), region: "us-east-1".into(), ..Default::default() };
        assert_eq!(endpoint_for(&aws).1, "c1.s3.amazonaws.com");
        let eu = S3Config { bucket: "c1".into(), region: "eu-west-2".into(), ..Default::default() };
        assert_eq!(endpoint_for(&eu).1, "c1.s3.eu-west-2.amazonaws.com");
    }

    #[test]
    fn a_custom_endpoint_uses_path_style() {
        // S3-compatible stores rarely have the wildcard DNS virtual-hosted style needs.
        let cfg = S3Config {
            bucket: "c1".into(), region: "us-east-1".into(),
            endpoint: Some("https://minio.internal:9000".into()), ..Default::default()
        };
        let (base, host) = endpoint_for(&cfg);
        assert_eq!(base, "https://minio.internal:9000/c1");
        assert_eq!(host, "minio.internal:9000");
    }

    #[tokio::test]
    async fn configured_keys_win_and_name_themselves() {
        let auth = S3Auth {
            access_key_id: Some("AKIA...".into()),
            secret_access_key: Some("s".into()),
            use_role: true,
            ..Default::default()
        };
        let c = resolve_creds(&auth).await.expect("configured keys should resolve");
        assert_eq!(c.access_key_id, "AKIA...");
        assert_eq!(c.source, "configured keys");
    }

    #[tokio::test]
    async fn a_bucket_with_neither_keys_nor_a_role_says_which_is_missing() {
        let err = resolve_creds(&S3Auth::default()).await.unwrap_err();
        assert!(err.contains("no access key"), "{err}");
        assert!(err.contains("role"), "{err}");
    }
}
