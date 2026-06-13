import Foundation
import Security

/// Keychain wrapper for storing secrets (currently per-data-source HTTP
/// headers, which typically carry `Authorization: Bearer ...` tokens).
///
/// Errors are surfaced rather than swallowed: callers like
/// `DataSourceManager.save()` need to know whether a write succeeded before
/// they strip the plaintext copy from UserDefaults — silently dropping an
/// OSStatus there would mean silently losing the user's API tokens.
enum KeychainHelper {
    private static let service = "is.peterlew.pcc"

    enum KeychainError: Error, LocalizedError {
        case unexpectedStatus(OSStatus)

        var errorDescription: String? {
            switch self {
            case .unexpectedStatus(let status):
                let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
                return "Keychain error: \(message)"
            }
        }
    }

    /// Every call goes through the same identifying query so set/get/delete
    /// can never drift onto different items.
    private static func baseQuery(forKey key: String) -> [String: Any] {
        [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    /// Store a string, treating an empty value as a delete.
    ///
    /// Updates in place via `SecItemUpdate` and only falls back to
    /// `SecItemAdd` when the item doesn't exist yet — unlike the
    /// delete-then-add dance, this never passes through a window where the
    /// old value is gone but the new one isn't stored.
    static func set(_ value: String, forKey key: String) throws {
        guard !value.isEmpty else {
            try delete(forKey: key)
            return
        }

        let attributes: [String: Any] = [kSecValueData as String: Data(value.utf8)]
        let updateStatus = SecItemUpdate(baseQuery(forKey: key) as CFDictionary,
                                         attributes as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var add = baseQuery(forKey: key)
            add[kSecValueData as String] = Data(value.utf8)
            // AfterFirstUnlock: a background menu-bar app polls data sources
            // without the user interacting, so the secret must be readable
            // any time after boot-unlock — but not while locked pre-login.
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(addStatus)
            }
        default:
            throw KeychainError.unexpectedStatus(updateStatus)
        }
    }

    /// Fetch a stored string.
    ///
    /// Returns `nil` when no item exists — distinct from a stored empty
    /// string, and distinct from real failures, which throw. Callers use the
    /// nil case to decide whether a legacy plaintext value still needs
    /// migrating into the Keychain.
    static func get(forKey key: String) throws -> String? {
        var query = baseQuery(forKey: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { return nil }
            return String(data: data, encoding: .utf8)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Remove a stored item. Deleting something that was never stored is not
    /// an error — delete is called unconditionally when sources are removed.
    static func delete(forKey key: String) throws {
        let status = SecItemDelete(baseQuery(forKey: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }
}
