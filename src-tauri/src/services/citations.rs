// Reference lookup for Docs' citations: resolves a DOI to CSL-JSON (the citation-data format
// Zotero, Crossref and DataCite all speak) through doi.org's content negotiation, which hands the
// request to whichever registry issued the DOI - Crossref for journal articles, DataCite for arXiv
// preprints (10.48550/arXiv.*), datasets and theses. The frontend normalizes and stores the result
// (src/utils/docBibliography.ts).
//
// Done here rather than with fetch() in the webview: the app's CSP keeps the webview off the
// network entirely, and this is the one place Docs needs it - only when the user asks to add a
// reference by DOI or arXiv ID. Nothing about the document is sent; the request is the DOI alone.
use std::sync::OnceLock;
use std::time::Duration;

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(10))
            // Crossref asks API clients to identify themselves; it routes them to its reliable pool.
            .user_agent(concat!("Briefcast/", env!("CARGO_PKG_VERSION"), " (Docs citations)"))
            .build()
            .unwrap_or_default()
    })
    .clone()
}

// DOIs may contain characters that are meaningful in a URL (#, ?, %, <, spaces in old DOIs);
// everything but unreserved characters and the prefix/suffix "/" is percent-encoded.
fn encode_doi(doi: &str) -> String {
    doi.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b'(' | b')' | b';' | b':' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

#[tauri::command(async)]
pub async fn lookup_doi(doi: String) -> Result<String, String> {
    let doi = doi.trim();
    if !doi.starts_with("10.") || !doi.contains('/') || doi.len() > 300 {
        return Err("That doesn't look like a DOI.".into());
    }
    let url = format!("https://doi.org/{}", encode_doi(doi));
    let response = client()
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/vnd.citationstyles.csl+json")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "doi.org didn't answer in time. Check your connection and try again.".to_string()
            } else if e.is_connect() {
                "Couldn't reach doi.org. Check your internet connection.".to_string()
            } else {
                format!("Couldn't look up the DOI: {}", e)
            }
        })?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("No published work has the DOI {}.", doi));
    }
    if !status.is_success() {
        return Err(format!("doi.org couldn't provide citation data for this DOI (HTTP {}).", status.as_u16()));
    }
    let body = response.text().await.map_err(|e| format!("Couldn't read the citation data: {}", e))?;
    if !body.trim_start().starts_with('{') {
        return Err("The registry for this DOI didn't return citation data.".into());
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::encode_doi;

    #[test]
    fn keeps_doi_structure_and_escapes_url_syntax() {
        assert_eq!(encode_doi("10.1038/s41586-021-03585-1"), "10.1038/s41586-021-03585-1");
        assert_eq!(encode_doi("10.1002/(SICI)1097-0258"), "10.1002/(SICI)1097-0258");
        assert_eq!(encode_doi("10.1000/a#b?c"), "10.1000/a%23b%3Fc");
    }
}
