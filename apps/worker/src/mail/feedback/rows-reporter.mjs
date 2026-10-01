export default class RowsReporter {
  onTestCaseAnnotate(_testCase, annotation) {
    process.stdout.write(`P4-07 rows_read evidence: ${JSON.stringify(annotation)}\n`);
  }
}
