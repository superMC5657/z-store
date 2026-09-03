use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SignatureInfo {
    pub is_signed: bool,
    pub is_valid: bool,
    pub status: String,
    pub status_message: Option<String>,
    pub subject: Option<String>,
    pub issuer: Option<String>,
    pub serial_number: Option<String>,
    pub thumbprint_sha1: Option<String>,
    pub thumbprint_sha256: Option<String>,
    pub error_message: Option<String>,
}

impl Default for SignatureInfo {
    fn default() -> Self {
        Self {
            is_signed: false,
            is_valid: false,
            status: "NotSigned".to_string(),
            status_message: None,
            subject: None,
            issuer: None,
            serial_number: None,
            thumbprint_sha1: None,
            thumbprint_sha256: None,
            error_message: None,
        }
    }
}

pub struct AuthenticodeVerifier;

impl AuthenticodeVerifier {
    /// 标准化指纹字符串：移除冒号、横杠、空格等标点，转为全大写 16 进制字符串
    pub fn normalize_fingerprint(fp: &str) -> String {
        fp.chars()
            .filter(|c| c.is_ascii_hexdigit())
            .collect::<String>()
            .to_uppercase()
    }

    /// 核验证书指纹与预期是否一致（支持 SHA-256 或 SHA-1 格式）
    pub fn verify_fingerprint(
        actual_sig: &SignatureInfo,
        expected_fingerprint: &str,
    ) -> Result<bool, String> {
        let norm_expected = Self::normalize_fingerprint(expected_fingerprint);
        if norm_expected.is_empty() {
            return Ok(true);
        }

        if !actual_sig.is_signed {
            return Err("目标安装文件未包含任何 Authenticode 数字签名，无法进行发布者证书指纹比对".to_string());
        }

        // 1. 比对 SHA-256 指纹
        if let Some(ref sha256) = actual_sig.thumbprint_sha256 {
            let norm_actual = Self::normalize_fingerprint(sha256);
            if norm_actual == norm_expected {
                return Ok(true);
            }
        }

        // 2. 比对 SHA-1 指纹（当预期指纹为 40 位 SHA-1 时）
        if let Some(ref sha1) = actual_sig.thumbprint_sha1 {
            let norm_actual = Self::normalize_fingerprint(sha1);
            if norm_actual == norm_expected {
                return Ok(true);
            }
        }

        let actual_disp = actual_sig
            .thumbprint_sha256
            .as_deref()
            .or(actual_sig.thumbprint_sha1.as_deref())
            .unwrap_or("未知");

        Err(format!(
            "安全拦截：发布者数字签名指纹冲突！官方预期指纹: [{}]，实际签名证书指纹: [{}]。为防止供应链篡改投毒，已阻断后续执行。",
            expected_fingerprint, actual_disp
        ))
    }

    /// 读取并核验指定二进制文件（.exe 或 .msi）的 Windows 数字签名信息
    pub fn extract_signature(path: &Path) -> Result<SignatureInfo, String> {
        #[cfg(target_os = "windows")]
        {
            if !path.exists() {
                return Err(format!("文件不存在: {:?}", path));
            }

            let escaped_path = path.to_string_lossy().replace('\'', "''");
            let cmd_str = format!(
                "& {{ Import-Module Microsoft.PowerShell.Security -ErrorAction SilentlyContinue; \
                $p = '{}'; \
                if (-not (Test-Path -LiteralPath $p)) {{ \
                    Write-Output '{{\"is_signed\":false,\"is_valid\":false,\"status\":\"FileNotFound\",\"status_message\":\"File not found\",\"error_message\":\"File not found\"}}'; \
                    exit 0; \
                }}; \
                $sig = Get-AuthenticodeSignature -LiteralPath $p; \
                $hasCert = ($null -ne $sig.SignerCertificate); \
                $sha256 = $null; \
                $subject = $null; \
                $issuer = $null; \
                $serial = $null; \
                $thumb1 = $null; \
                if ($hasCert) {{ \
                    $sha = [System.Security.Cryptography.SHA256]::Create(); \
                    $sha256 = [BitConverter]::ToString($sha.ComputeHash($sig.SignerCertificate.RawData)).Replace('-', ':'); \
                    $subject = $sig.SignerCertificate.Subject; \
                    $issuer = $sig.SignerCertificate.Issuer; \
                    $serial = $sig.SignerCertificate.SerialNumber; \
                    $thumb1 = $sig.SignerCertificate.Thumbprint; \
                }}; \
                @{{ \
                    is_signed = $hasCert; \
                    is_valid = ($sig.Status -eq 0 -or [string]$sig.Status -eq 'Valid'); \
                    status = [string]$sig.Status; \
                    status_message = [string]$sig.StatusMessage; \
                    subject = $subject; \
                    issuer = $issuer; \
                    serial_number = $serial; \
                    thumbprint_sha1 = $thumb1; \
                    thumbprint_sha256 = $sha256; \
                    error_message = $null; \
                }} | ConvertTo-Json -Compress; }}",
                escaped_path
            );

            let win_dir = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
            let clean_psmodulepath = format!("{}\\System32\\WindowsPowerShell\\v1.0\\Modules", win_dir);

            let output = std::process::Command::new("powershell")
                .env("PSModulePath", &clean_psmodulepath)
                .arg("-NoLogo")
                .arg("-NoProfile")
                .arg("-NonInteractive")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-Command")
                .arg(&cmd_str)
                .output()
                .map_err(|e| format!("启动签名核验进程失败: {}", e))?;

            if !output.status.success() {
                let err = String::from_utf8_lossy(&output.stderr);
                return Err(format!("签名提取脚本执行失败: {}", err));
            }

            let stdout = String::from_utf8_lossy(&output.stdout);
            let trimmed = stdout.trim();

            if trimmed.is_empty() {
                return Ok(SignatureInfo::default());
            }

            // 智能截取首个完整 JSON 对象，避免任何环境 banner 或 trailing 干扰
            let json_slice = match (trimmed.find('{'), trimmed.rfind('}')) {
                (Some(start), Some(end)) if start < end => &trimmed[start..=end],
                _ => return Ok(SignatureInfo::default()),
            };

            let info: SignatureInfo = serde_json::from_str(json_slice)
                .map_err(|e| format!("解析签名信息 JSON 失败: {} (截取内容: {})", e, json_slice))?;

            Ok(info)
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = path;
            Ok(SignatureInfo {
                is_signed: false,
                is_valid: false,
                status: "UnsupportedPlatform".to_string(),
                status_message: Some("当前非 Windows 平台，跳过 Authenticode 签名核验".to_string()),
                subject: None,
                issuer: None,
                serial_number: None,
                thumbprint_sha1: None,
                thumbprint_sha256: None,
                error_message: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_fingerprint() {
        assert_eq!(
            AuthenticodeVerifier::normalize_fingerprint("e8:7a:b4:9c:3d:12:fa:45"),
            "E87AB49C3D12FA45"
        );
        assert_eq!(
            AuthenticodeVerifier::normalize_fingerprint("E8-7A-B4-9C-3D-12-FA-45"),
            "E87AB49C3D12FA45"
        );
        assert_eq!(
            AuthenticodeVerifier::normalize_fingerprint("  e8 7a b4 9c 3d 12 fa 45  "),
            "E87AB49C3D12FA45"
        );
    }

    #[test]
    fn test_verify_fingerprint_matching() {
        let sig = SignatureInfo {
            is_signed: true,
            is_valid: true,
            status: "Valid".to_string(),
            status_message: Some("Signature verified".to_string()),
            subject: Some("CN=Test App".to_string()),
            issuer: Some("CN=Test CA".to_string()),
            serial_number: Some("123456".to_string()),
            thumbprint_sha1: Some("3B77DB29AC72AA6B5880ECB2ED5EC1EC6601D847".to_string()),
            thumbprint_sha256: Some(
                "D3:39:27:E4:DD:A9:B9:1D:EF:9F:8E:D2:82:54:9A:49:21:7E:D8:CA:CF:54:57:7A:69:09:63:CB:C5:EF:F3:ED".to_string(),
            ),
            error_message: None,
        };

        // 1. SHA-256 冒号形式匹配
        assert!(AuthenticodeVerifier::verify_fingerprint(
            &sig,
            "D3:39:27:E4:DD:A9:B9:1D:EF:9F:8E:D2:82:54:9A:49:21:7E:D8:CA:CF:54:57:7A:69:09:63:CB:C5:EF:F3:ED"
        )
        .is_ok());

        // 2. SHA-256 小写无分隔符匹配
        assert!(AuthenticodeVerifier::verify_fingerprint(
            &sig,
            "d33927e4dda9b91def9f8ed282549a49217ed8cacf54577a690963cbc5eff3ed"
        )
        .is_ok());

        // 3. SHA-1 指纹匹配
        assert!(AuthenticodeVerifier::verify_fingerprint(
            &sig,
            "3B:77:DB:29:AC:72:AA:6B:58:80:EC:B2:ED:5E:C1:EC:66:01:D8:47"
        )
        .is_ok());

        // 4. 空预期指纹平滑放行
        assert!(AuthenticodeVerifier::verify_fingerprint(&sig, "").is_ok());

        // 5. 错误指纹应当拦截报错
        let result = AuthenticodeVerifier::verify_fingerprint(&sig, "AA:BB:CC:DD:EE:FF");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("发布者数字签名指纹冲突"));
    }

    #[test]
    fn test_verify_fingerprint_unsigned_error() {
        let unsigned = SignatureInfo {
            is_signed: false,
            is_valid: false,
            status: "NotSigned".to_string(),
            status_message: None,
            subject: None,
            issuer: None,
            serial_number: None,
            thumbprint_sha1: None,
            thumbprint_sha256: None,
            error_message: None,
        };

        let result = AuthenticodeVerifier::verify_fingerprint(&unsigned, "D3:39:27:E4");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("未包含任何 Authenticode 数字签名"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_extract_real_windows_binary_signature() {
        let ps_path = std::path::Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        if ps_path.exists() {
            let sig = AuthenticodeVerifier::extract_signature(ps_path).unwrap();
            assert!(sig.is_signed);
            assert!(sig.thumbprint_sha256.is_some() || sig.thumbprint_sha1.is_some());
        }
    }
}
