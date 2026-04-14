import Foundation
import Security

/// Simple Keychain wrapper for storing strings securely.
enum KeychainHelper {
    private static let service = "is.peterlew.pcc"

    static func set(_ value: String, forKey key: String) {
        let data = Data(value.utf8)
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]

        // Delete any existing item first
        SecItemDelete(query as CFDictionary)

        guard !value.isEmpty else { return } // treat empty as delete

        var add = query
        add[kSecValueData as String] = data
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(forKey key: String) -> String {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// One-time migration from UserDefaults to Keychain.
    static func migrateFromDefaults(_ keys: [String]) {
        let d = UserDefaults.standard
        for key in keys {
            if let value = d.string(forKey: key), !value.isEmpty, get(forKey: key).isEmpty {
                set(value, forKey: key)
                d.removeObject(forKey: key)
            }
        }
    }
}
