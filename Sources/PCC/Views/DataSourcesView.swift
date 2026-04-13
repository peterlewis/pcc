import SwiftUI

struct DataSourcesView: View {
    @EnvironmentObject var serialManager: SerialManager
    @EnvironmentObject var dataSourceManager: DataSourceManager
    @State private var editingSource: DataSource?
    @State private var isAddingNew = false
    @State private var deleteTarget: DataSource?

    private let rotationOptions: [(label: String, value: TimeInterval)] = [
        ("5 seconds", 5),
        ("10 seconds", 10),
        ("30 seconds", 30),
        ("1 minute", 60),
        ("5 minutes", 300),
    ]

    var body: some View {
        Form {
            Section {
                Toggle("Enable Data Sources", isOn: Binding(
                    get: { dataSourceManager.isActive },
                    set: { dataSourceManager.setEnabled($0) }
                ))

                if dataSourceManager.enabledSources.count > 1 {
                    Picker("Rotate every", selection: Binding(
                        get: { dataSourceManager.rotationInterval },
                        set: { dataSourceManager.setRotationInterval($0) }
                    )) {
                        ForEach(rotationOptions, id: \.value) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                }

                if dataSourceManager.isActive,
                   let current = dataSourceManager.currentDisplayedSource {
                    HStack {
                        Text("Showing")
                            .foregroundStyle(.secondary)
                        Text(current.name)
                        Spacer()
                        let raw = dataSourceManager.lastValues[current.id] ?? "\u{2014}"
                        if raw.count > 10 {
                            Image(systemName: "arrow.left.arrow.right")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                        Text(raw)
                            .foregroundStyle(raw.count > 10 ? .orange : .secondary)
                            .lineLimit(1)
                    }
                    .font(.caption)
                }
            }

            Section {
                if dataSourceManager.dataSources.isEmpty {
                    Text("No data sources configured")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(dataSourceManager.dataSources) { source in
                        HStack {
                            DataSourceRow(
                                source: source,
                                isCurrent: dataSourceManager.currentDisplayedSource?.id == source.id,
                                lastValue: dataSourceManager.lastValues[source.id],
                                lastError: dataSourceManager.lastErrors[source.id]
                            )

                            Button {
                                editingSource = source
                                isAddingNew = false
                            } label: {
                                Image(systemName: "pencil")
                                    .font(.caption)
                            }
                            .buttonStyle(.borderless)

                            Button {
                                deleteTarget = source
                            } label: {
                                Image(systemName: "trash")
                                    .font(.caption)
                                    .foregroundStyle(.red)
                            }
                            .buttonStyle(.borderless)
                        }
                    }
                }
            } header: {
                HStack {
                    Text("Sources")
                    Spacer()
                    Button {
                        editingSource = DataSource()
                        isAddingNew = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.borderless)
                }
            }

            Section {
                Text("Enabled sources rotate on the clock display. Each source fetches data independently at its own poll interval.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .sheet(item: $editingSource) { source in
            DataSourceEditView(
                source: source,
                onSave: { saved in
                    if isAddingNew {
                        dataSourceManager.addSource(saved)
                    } else {
                        dataSourceManager.updateSource(saved)
                    }
                },
                onDelete: isAddingNew ? nil : {
                    dataSourceManager.deleteSource(id: source.id)
                }
            )
        }
        .alert("Delete Data Source?", isPresented: Binding(
            get: { deleteTarget != nil },
            set: { if !$0 { deleteTarget = nil } }
        )) {
            Button("Delete", role: .destructive) {
                if let source = deleteTarget {
                    dataSourceManager.deleteSource(id: source.id)
                }
                deleteTarget = nil
            }
            Button("Cancel", role: .cancel) {
                deleteTarget = nil
            }
        } message: {
            Text("Delete \"\(deleteTarget?.name ?? "")\"? This cannot be undone.")
        }
    }
}

// MARK: - Row

struct DataSourceRow: View {
    let source: DataSource
    let isCurrent: Bool
    let lastValue: String?
    let lastError: String?

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Image(systemName: source.type == .restAPI ? "network" : "terminal")
                        .foregroundStyle(.secondary)
                        .font(.caption)
                    Text(source.name.isEmpty ? "(unnamed)" : source.name)
                        .lineLimit(1)
                }
                if let error = lastError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(1)
                } else if let value = lastValue {
                    HStack(spacing: 3) {
                        if value.count > 10 {
                            Image(systemName: "arrow.left.arrow.right")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                        Text(value)
                            .font(.caption)
                            .foregroundStyle(value.count > 10 ? .orange : .secondary)
                            .lineLimit(1)
                    }
                }
            }
            Spacer()
            if isCurrent {
                Circle().fill(.green).frame(width: 6, height: 6)
            }
            if !source.isEnabled {
                Text("Disabled")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

// MARK: - Edit sheet

struct DataSourceEditView: View {
    @Environment(\.dismiss) var dismiss
    @State var source: DataSource
    let onSave: (DataSource) -> Void
    var onDelete: (() -> Void)?

    @State private var testResult: String?
    @State private var testError: String?
    @State private var isTesting = false
    @State private var showDeleteConfirm = false

    private let intervalOptions: [(label: String, value: TimeInterval)] = [
        ("30 seconds", 30),
        ("1 minute", 60),
        ("5 minutes", 300),
        ("15 minutes", 900),
        ("30 minutes", 1800),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Form {
                Section("General") {
                    TextField("Name", text: $source.name,
                              prompt: Text(source.type == .restAPI ? "e.g. GitHub repo stars" : "e.g. System uptime"))
                    Picker("Type", selection: $source.type) {
                        Text("REST API").tag(DataSourceType.restAPI)
                        Text("Bash Command").tag(DataSourceType.bashCommand)
                    }
                    Toggle("Enabled", isOn: $source.isEnabled)
                }

                Section(source.type == .restAPI ? "API Endpoint" : "Command") {
                    if source.type == .restAPI {
                        TextField("URL", text: $source.endpoint,
                                  prompt: Text("https://api.github.com/repos/peterlewis/pcc"))
                        TextField("JSON key path", text: $source.jsonKeyPath,
                                  prompt: Text("e.g. stargazers_count"))
                        Text("Dot-separated path to extract from JSON response. Leave blank for plain text APIs.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        TextField("Command", text: $source.endpoint,
                                  prompt: Text("uptime | awk '{print $3}'"))
                    }
                }

                Section("Display Format") {
                    TextField("Format", text: $source.displayFormat,
                              prompt: Text(source.type == .restAPI ? "{v} stars" : "{v} days"))
                    Text("Use {v} as a placeholder for the value. Leave blank to show the raw value.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("Refresh Interval") {
                    Picker("Fetch every", selection: $source.pollInterval) {
                        ForEach(intervalOptions, id: \.value) { option in
                            Text(option.label).tag(option.value)
                        }
                    }
                }

                Section("Test") {
                    HStack {
                        Button("Test Now") { runTest() }
                            .disabled(source.endpoint.isEmpty || isTesting)
                        if isTesting {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }

                    if let result = testResult {
                        let formatted = DataSourceManager.applyFormat(result, format: source.displayFormat)
                        HStack {
                            Text("Result:")
                            Text(formatted)
                                .foregroundStyle(formatted.count > 10 ? .red : .green)
                                .lineLimit(3)
                                .textSelection(.enabled)
                        }
                        .font(.caption)
                    }

                    if let error = testError {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .lineLimit(5)
                            .textSelection(.enabled)
                    }
                }
            }
            .formStyle(.grouped)

            HStack {
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)

                if onDelete != nil {
                    Button("Delete") {
                        showDeleteConfirm = true
                    }
                    .foregroundStyle(.red.opacity(0.7))
                }

                Spacer()
                Button("Save") {
                    onSave(source)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(source.name.isEmpty || source.endpoint.isEmpty)
            }
            .padding()
            .alert("Delete Data Source?", isPresented: $showDeleteConfirm) {
                Button("Delete", role: .destructive) {
                    onDelete?()
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Delete \"\(source.name)\"? This cannot be undone.")
            }
        }
        .frame(minWidth: 420, minHeight: 380)
    }

    // MARK: - Test

    private func runTest() {
        isTesting = true
        testResult = nil
        testError = nil

        switch source.type {
        case .restAPI:
            guard let url = URL(string: source.endpoint) else {
                testError = "Invalid URL"
                isTesting = false
                return
            }
            Task {
                do {
                    let (data, _) = try await URLSession.shared.data(from: url)
                    let value = DataSourceManager.extractValue(from: data, keyPath: source.jsonKeyPath)
                    await MainActor.run {
                        if let value, !value.isEmpty { testResult = value }
                        else {
                            let keyInfo = source.jsonKeyPath.isEmpty ? "" : " at key path \"\(source.jsonKeyPath)\""
                            testError = "No value found\(keyInfo)"
                        }
                        isTesting = false
                    }
                } catch {
                    await MainActor.run {
                        testError = error.localizedDescription
                        isTesting = false
                    }
                }
            }

        case .bashCommand:
            DispatchQueue.global(qos: .userInitiated).async {
                let process = Process()
                let pipe = Pipe()
                process.executableURL = URL(fileURLWithPath: "/bin/bash")
                process.arguments = ["-c", source.endpoint]
                process.standardOutput = pipe
                process.standardError = pipe
                do {
                    try process.run()
                    process.waitUntilExit()
                    let data = pipe.fileHandleForReading.readDataToEndOfFile()
                    let output = String(data: data, encoding: .utf8) ?? ""
                    let firstLine = output.trimmingCharacters(in: .whitespacesAndNewlines)
                        .components(separatedBy: .newlines).first
                    DispatchQueue.main.async {
                        if let firstLine, !firstLine.isEmpty { testResult = firstLine }
                        else { testError = "No output from command" }
                        isTesting = false
                    }
                } catch {
                    DispatchQueue.main.async {
                        testError = error.localizedDescription
                        isTesting = false
                    }
                }
            }
        }
    }
}
