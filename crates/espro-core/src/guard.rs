//! READ-ONLY GUARD — the single chokepoint for every request the app makes.
//!
//! GET and HEAD are always allowed. POST is allowed only for the search family, where
//! the method is a transport detail (the query travels in the body) and the API cannot
//! mutate cluster state. Everything else — PUT, DELETE, any other POST — is refused
//! before a socket is opened. The switch is `readOnly: false` in clusters.yaml: a
//! decision on disk, under the operator's control, not a click in the UI.

use regex::Regex;
use std::sync::LazyLock;

static READONLY_POST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(^|/)_(search|msearch|count|field_caps|mget|explain|validate/query|render/template|terms_enum|search_shards|async_search|eql/search|sql|sql/translate|analyze|rank_eval|resolve/index|knn_search)(/|\?|$)",
    )
    .expect("static regex")
});

/// `Some(reason)` when the request must be refused.
pub fn write_guard(read_only: bool, method: &str, path: &str) -> Option<String> {
    let m = method.trim().to_ascii_uppercase();
    if m == "GET" || m == "HEAD" {
        return None;
    }
    if !read_only {
        return None;
    }
    let bare = path.split('?').next().unwrap_or("/");
    if m == "POST" && READONLY_POST.is_match(bare) {
        return None;
    }
    Some(format!(
        "Blocked by read-only mode: {m} {bare}. This build only sends GET/HEAD plus search-family POSTs. \
         Set `readOnly: false` in clusters.yaml to allow writes."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allows_reads_and_search() {
        assert!(write_guard(true, "GET", "/_cluster/health").is_none());
        assert!(write_guard(true, "HEAD", "/").is_none());
        assert!(write_guard(true, "POST", "/logstash-*/_search?size=0").is_none());
        assert!(write_guard(true, "POST", "/_msearch").is_none());
        assert!(write_guard(true, "POST", "/_sql?format=json").is_none());
        assert!(write_guard(true, "POST", "/idx/_count").is_none());
    }
    #[test]
    fn blocks_everything_else() {
        assert!(write_guard(true, "PUT", "/idx").is_some());
        assert!(write_guard(true, "DELETE", "/idx").is_some());
        assert!(write_guard(true, "POST", "/_slm/policy/daily/_execute").is_some());
        assert!(write_guard(true, "POST", "/idx/_doc").is_some());
        assert!(write_guard(true, "POST", "/_searchx").is_some());
        assert!(write_guard(true, "post", "/_cluster/reroute").is_some());
        assert!(write_guard(true, "POST", "/_search_shards_not").is_some());
    }
    #[test]
    fn off_switch() {
        assert!(write_guard(false, "DELETE", "/idx").is_none());
    }
}
