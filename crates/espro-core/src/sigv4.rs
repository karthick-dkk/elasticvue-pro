//! AWS Signature Version 4.
//!
//! Written here rather than pulled in, for the same reason the rest of this crate is:
//! the alternative is the AWS SDK, which is a large dependency tree to sign a request
//! and list a bucket. This is the whole of what ULM needs — GET with an empty payload,
//! signed for S3 — and nothing else.
//!
//! Signing is the kind of code where "looks right" and "is right" are indistinguishable
//! without a reference: every mistake produces a signature that is well-formed, the
//! right length, and rejected by AWS with the same opaque 403 as a wrong key. So the
//! tests below run the published vectors from AWS's own SigV4 test suite, and the
//! intermediate strings are compared too — a canonical request that differs by one
//! newline fails in a way the final signature cannot explain.
//!
//! The four steps, which are worth naming because the spec's own names are used
//! throughout:
//!
//! 1. **Canonical request** — the method, path, query and headers in a fixed shape.
//! 2. **String to sign** — the algorithm, timestamp, credential scope and a hash of (1).
//! 3. **Signing key** — the secret, walked through date, region and service.
//! 4. **Signature** — HMAC of (2) with (3).

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub const ALGORITHM: &str = "AWS4-HMAC-SHA256";
/// The hash of an empty body. S3 wants it by name on every unsigned-payload GET.
pub const EMPTY_PAYLOAD_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("hmac takes any key length");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

/// Percent-encode per RFC 3986, which is stricter than a URL encoder.
///
/// The unreserved set is exactly `A-Za-z0-9-_.~`; everything else is `%XX` with upper-
/// case hex. `encode_slash` is false only for a URI path, where the separators stay
/// literal — an object key containing a slash is a different key from one containing
/// `%2F`, and S3 treats them as such.
pub fn uri_encode(s: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b'/' if !encode_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// One header, already lowercased and trimmed the way the canonical form wants it.
#[derive(Clone, Debug)]
pub struct Header {
    pub name: String,
    pub value: String,
}

impl Header {
    pub fn new(name: &str, value: &str) -> Header {
        Header {
            name: name.trim().to_ascii_lowercase(),
            // Sequential spaces collapse, per the spec. Values are not otherwise touched:
            // the signature covers what is actually sent.
            value: collapse_spaces(value.trim()),
        }
    }
}

fn collapse_spaces(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut last_space = false;
    for c in v.chars() {
        if c == ' ' {
            if !last_space {
                out.push(c);
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out
}

/// What is being signed.
#[derive(Clone, Debug)]
pub struct Request<'a> {
    pub method: &'a str,
    /// Already-encoded absolute path, beginning with `/`.
    pub path: &'a str,
    /// `(name, value)` pairs, unencoded. Sorted and encoded here.
    pub query: Vec<(String, String)>,
    pub headers: Vec<Header>,
    /// Hex sha256 of the body.
    pub payload_sha256: String,
}

/// Step 1. Returned rather than hashed so a failing test can show where it diverged.
pub fn canonical_request(req: &Request<'_>) -> String {
    let mut query: Vec<(String, String)> = req
        .query
        .iter()
        .map(|(k, v)| (uri_encode(k, true), uri_encode(v, true)))
        .collect();
    // Sorted by encoded name, then by encoded value — byte order, not locale order.
    query.sort();
    let canonical_query = query
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");

    let mut headers = req.headers.clone();
    headers.sort_by(|a, b| a.name.cmp(&b.name));
    let canonical_headers = headers
        .iter()
        .map(|h| format!("{}:{}\n", h.name, h.value))
        .collect::<String>();
    let signed_headers = signed_headers(&req.headers);

    format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        req.method.to_ascii_uppercase(),
        if req.path.is_empty() { "/" } else { req.path },
        canonical_query,
        canonical_headers,
        signed_headers,
        req.payload_sha256,
    )
}

/// The `SignedHeaders` list: lowercase names, sorted, semicolon separated.
pub fn signed_headers(headers: &[Header]) -> String {
    let mut names: Vec<&str> = headers.iter().map(|h| h.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    names.join(";")
}

/// `20150830/us-east-1/s3/aws4_request`
pub fn credential_scope(date: &str, region: &str, service: &str) -> String {
    format!("{date}/{region}/{service}/aws4_request")
}

/// Step 2.
pub fn string_to_sign(datetime: &str, scope: &str, canonical_request: &str) -> String {
    format!(
        "{ALGORITHM}\n{datetime}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    )
}

/// Step 3. Each round replaces the key, which is what stops the secret being recoverable
/// from a leaked signing key: it is only good for that date, region and service.
pub fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    hmac(&k_service, b"aws4_request")
}

/// Step 4.
pub fn signature(secret: &str, date: &str, region: &str, service: &str, to_sign: &str) -> String {
    hex::encode(hmac(&signing_key(secret, date, region, service), to_sign.as_bytes()))
}

/// The complete `Authorization` header value.
pub fn authorization(
    access_key: &str,
    secret: &str,
    region: &str,
    service: &str,
    datetime: &str,
    req: &Request<'_>,
) -> String {
    let date = &datetime[..8];
    let scope = credential_scope(date, region, service);
    let creq = canonical_request(req);
    let sts = string_to_sign(datetime, &scope, &creq);
    let sig = signature(secret, date, region, service, &sts);
    format!(
        "{ALGORITHM} Credential={access_key}/{scope}, SignedHeaders={}, Signature={sig}",
        signed_headers(&req.headers)
    )
}

/// `20150830T123600Z` from milliseconds since the epoch.
pub fn amz_date(ms: i64) -> String {
    let (y, mo, d) = crate::delay_sink::civil_from_days(ms.div_euclid(86_400_000));
    let rem = ms.rem_euclid(86_400_000);
    let (h, mi, s) = (rem / 3_600_000, (rem / 60_000) % 60, (rem / 1000) % 60);
    format!("{y:04}{mo:02}{d:02}T{h:02}{mi:02}{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `get-vanilla` case from AWS's published SigV4 test suite, which is also the
    /// worked example in the signing documentation. Every intermediate value is checked,
    /// not only the signature: a canonical request that differs by one newline produces
    /// a wrong signature with nothing to say about why.
    const AKID: &str = "AKIDEXAMPLE";
    const SECRET: &str = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    const REGION: &str = "us-east-1";
    const SERVICE: &str = "service";
    const DATETIME: &str = "20150830T123600Z";

    fn vanilla() -> Request<'static> {
        Request {
            method: "GET",
            path: "/",
            query: vec![],
            headers: vec![
                Header::new("Host", "example.amazonaws.com"),
                Header::new("X-Amz-Date", DATETIME),
            ],
            payload_sha256: EMPTY_PAYLOAD_SHA256.to_string(),
        }
    }

    #[test]
    fn get_vanilla_canonical_request() {
        let want = "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\n\
                    host;x-amz-date\n\
                    e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(canonical_request(&vanilla()), want);
    }

    #[test]
    fn get_vanilla_string_to_sign() {
        let scope = credential_scope("20150830", REGION, SERVICE);
        let sts = string_to_sign(DATETIME, &scope, &canonical_request(&vanilla()));
        // The hash here was checked twice over rather than taken on trust: this crate and
        // a separate python implementation produce the same value, and the end-to-end
        // signature below matches AWS's published one — which it could not if the string
        // being signed were wrong.
        let want = "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n\
                    bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63";
        assert_eq!(sts, want);
    }

    #[test]
    fn get_vanilla_signature() {
        let sig = authorization(AKID, SECRET, REGION, SERVICE, DATETIME, &vanilla());
        assert_eq!(
            sig,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, \
             Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    /// Distinct names, sorted. This one does NOT catch a name-only sort — both orders
    /// agree when every name is unique — which is what the case below is for.
    #[test]
    fn query_parameters_are_sorted() {
        let req = Request {
            method: "GET",
            path: "/",
            query: vec![("Param2".into(), "value2".into()), ("Param1".into(), "value1".into())],
            headers: vec![
                Header::new("Host", "example.amazonaws.com"),
                Header::new("X-Amz-Date", DATETIME),
            ],
            payload_sha256: EMPTY_PAYLOAD_SHA256.to_string(),
        };
        let creq = canonical_request(&req);
        assert!(creq.contains("Param1=value1&Param2=value2"), "{creq}");
        let auth = authorization(AKID, SECRET, REGION, SERVICE, DATETIME, &req);
        assert!(
            auth.ends_with("Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500"),
            "{auth}"
        );
    }

    /// `get-vanilla-query-order-key-case`: one name, two values. The spec sorts by name
    /// and then by value, so the pair must come back in value order however it went in.
    ///
    /// This is the case that distinguishes a correct sort from a name-only one. A
    /// mutation that sorted by name alone survived the test above — every name there is
    /// unique, so both orders agree — and was only caught once a name repeated.
    #[test]
    fn repeated_query_names_sort_by_value() {
        let req = Request {
            method: "GET",
            path: "/",
            query: vec![("Param1".into(), "value2".into()), ("Param1".into(), "value1".into())],
            headers: vec![
                Header::new("Host", "example.amazonaws.com"),
                Header::new("X-Amz-Date", DATETIME),
            ],
            payload_sha256: EMPTY_PAYLOAD_SHA256.to_string(),
        };
        let creq = canonical_request(&req);
        let query_line = creq.lines().nth(2).unwrap_or("");
        assert_eq!(query_line, "Param1=value1&Param1=value2",
                   "values did not sort once the names tied:\n{creq}");
    }

    #[test]
    fn header_values_have_their_spaces_collapsed() {
        // `get-header-value-trim` in the suite: leading, trailing and repeated spaces all
        // normalise, because a proxy may rewrite them and the signature must survive it.
        assert_eq!(Header::new("My-Header", "  a  b  c  ").value, "a b c");
        assert_eq!(Header::new("  Upper-Case  ", "v").name, "upper-case");
    }

    #[test]
    fn uri_encoding_follows_rfc3986_not_the_usual_url_rules() {
        // The four unreserved punctuation marks stay literal; a space is %20 and never
        // a plus; the hex is upper-case.
        assert_eq!(uri_encode("-_.~", true), "-_.~");
        assert_eq!(uri_encode("a b", true), "a%20b");
        assert_eq!(uri_encode("a+b", true), "a%2Bb");
        assert_eq!(uri_encode("ß", true), "%C3%9F");
        // A path keeps its separators; a query value does not.
        assert_eq!(uri_encode("a/b", false), "a/b");
        assert_eq!(uri_encode("a/b", true), "a%2Fb");
    }

    #[test]
    fn the_signing_key_is_specific_to_date_region_and_service() {
        let base = signing_key(SECRET, "20150830", REGION, SERVICE);
        assert_ne!(base, signing_key(SECRET, "20150831", REGION, SERVICE), "date is not in the key");
        assert_ne!(base, signing_key(SECRET, "20150830", "eu-west-1", SERVICE), "region is not in the key");
        assert_ne!(base, signing_key(SECRET, "20150830", REGION, "s3"), "service is not in the key");
    }

    #[test]
    fn the_timestamp_is_the_shape_aws_wants() {
        // 2015-08-30T12:36:00Z
        let ms = 1_440_938_160_000;
        assert_eq!(amz_date(ms), "20150830T123600Z");
        assert_eq!(&amz_date(ms)[..8], "20150830", "the scope date is the first eight characters");
    }
}
