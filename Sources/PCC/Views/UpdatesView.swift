import SwiftUI

struct UpdatesView: View {
    @StateObject private var updateManager = UpdateManager()

    var body: some View {
        Form {
            Section {
                HStack {
                    Image(systemName: updateManager.clockMounted ? "externaldrive.fill" : "externaldrive")
                        .foregroundStyle(updateManager.clockMounted ? .green : .secondary)
                    Text(updateManager.clockMounted ? "CLOCK mounted" : "CLOCK not mounted")
                    Spacer()
                    Button("Refresh") { updateManager.refresh() }
                }

                if updateManager.clockMounted {
                    if let fwt = updateManager.installedFWT {
                        LabeledContent("Firmware (time)") {
                            Text("v\(fwt.version)  \(fwt.buildDate)")
                                .font(.caption)
                        }
                    }
                    if let fwd = updateManager.installedFWD {
                        LabeledContent("Firmware (date)") {
                            Text("v\(fwd.version)  \(fwd.buildDate)")
                                .font(.caption)
                        }
                    }
                    if let tzDate = updateManager.installedTZDate {
                        LabeledContent("Timezone data") {
                            Text(tzDate, style: .date)
                                .font(.caption)
                        }
                    }
                }
            } header: {
                Text("Installed")
            }

            Section {
                if let release = updateManager.latestRelease {
                    LabeledContent("Release") { Text(release.tag) }
                    if !release.fwtBuild.isEmpty {
                        LabeledContent("Firmware (time)") {
                            Text(release.fwtBuild).font(.caption)
                        }
                    }
                    if !release.fwdBuild.isEmpty {
                        LabeledContent("Firmware (date)") {
                            Text(release.fwdBuild).font(.caption)
                        }
                    }
                    if !release.tzVersion.isEmpty {
                        LabeledContent("Timezone data") {
                            Text(release.tzVersion).font(.caption)
                        }
                    }
                } else if updateManager.isChecking {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Checking...")
                    }
                } else {
                    Text("Not checked yet")
                        .foregroundStyle(.secondary)
                }

                Button("Check for Updates") {
                    updateManager.checkForUpdates()
                }
                .disabled(updateManager.isChecking)

                if let error = updateManager.error {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            } header: {
                Text("Latest Release")
            }

            if updateManager.latestRelease != nil && updateManager.clockMounted {
                Section {
                    if updateManager.isInstalling {
                        HStack {
                            ProgressView().controlSize(.small)
                            Text(updateManager.installProgress)
                        }
                    } else if updateManager.installProgress == "Done. Eject or reconnect the clock to apply." {
                        HStack {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                            Text(updateManager.installProgress)
                        }
                    }

                    Button("Install Firmware + Timezone Data") {
                        updateManager.installUpdate(firmware: true, timezone: true)
                    }
                    .disabled(updateManager.isInstalling)

                    Button("Install Firmware Only") {
                        updateManager.installUpdate(firmware: true, timezone: false)
                    }
                    .disabled(updateManager.isInstalling)

                    Button("Install Timezone Data Only") {
                        updateManager.installUpdate(firmware: false, timezone: true)
                    }
                    .disabled(updateManager.isInstalling)

                    Text("Copying files to the clock is slow by design \u{2014} the clock prioritises display stability over USB transfer speed. After installation, eject or reconnect the clock to apply the update.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Install")
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { updateManager.refresh() }
    }
}
