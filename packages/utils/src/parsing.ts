import BigNumber from 'bignumber.js'

export const stringToBoolean = (inputString: string): boolean => {
  const lowercasedInput = inputString.toLowerCase().trim()
  if (lowercasedInput === 'true') {
    return true
  } else if (lowercasedInput === 'false') {
    return false
  }
  throw new Error(`Unable to parse '${inputString}' as boolean`)
}

export const parseInputAmount = (
  inputString: string,
  decimalSeparator: string = '.'
): BigNumber => {
  // BigNumber is only able to parse decimals with a period as
  // a decimal separator, so we need to convert here manually.
  // https://github.com/MikeMcl/bignumber.js/issues/126

  // Number should have ONLY digits and one optional decimal separator
  if (inputString.replace(/[0-9]/g, '').replace(decimalSeparator, '').length) {
    return new BigNumber(NaN)
  }
  if (decimalSeparator !== '.') {
    inputString = inputString.replace(decimalSeparator, '.')
  }
  return new BigNumber(inputString || '0')
}

/**
 * Parses an "array of strings" that is returned from a Solidity function
 *
 * @param stringLengths length of each string in bytes
 * @param data 0x-prefixed, hex-encoded string data in utf-8 bytes
 */
export const parseSolidityStringArray = (stringLengths: number[], data: string) => {
  if (data === null) {
    data = '0x'
  }
  const ret: string[] = []
  let offset = 0
  // @ts-ignore
  const rawData = Buffer.from(data.slice(2), 'hex')
  // tslint:disable-next-line:prefer-for-of
  for (let i = 0; i < stringLengths.length; i++) {
    const string = rawData.toString('utf-8', offset, offset + stringLengths[i])
    offset += stringLengths[i]
    ret.push(string)
  }
  return ret
}
